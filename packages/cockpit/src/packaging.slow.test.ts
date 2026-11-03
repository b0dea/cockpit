import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parseNpmPackJson, type NpmPackArtifact } from './test-support/npm-pack-json.js'
import { cockpitPackageVersion } from './test-support/package-version.js'
import { expectedPackageFiles } from '../../../scripts/supply-chain-check.ts'
import { walkMarkdownProse } from '../../../scripts/docs-lint.ts'

// What a consumer installs is a different surface from what this repository contains, and
// only one of them is checked by reading the tree. Without an allow-list npm ships every
// file under the package directory, so a file added for development leaves for the registry
// on the next publish with nobody deciding that it should.

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

// npm accepts any string as `license`, prose included, and then publishes a licence nobody
// can resolve to a text. There is no SPDX list in this tree to check against, so this is
// membership in the set we would actually publish under — narrow, but it can go red.
const SPDX_IDS = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']

// Direct runtime dependencies leave with every installation, so each licence is an explicit
// publication decision rather than an incidental fact accepted from the lockfile.
const RUNTIME_DEPENDENCY_LICENSES = {
    'smol-toml': 'BSD-3-Clause',
    yaml: 'ISC',
    zod: 'MIT',
} as const

// One pack attempt per test file. Re-entering a partial fixture hides the first failure behind
// setup collisions, while every assertion is intentionally about the same immutable artifact.
type Attempt<T> = Readonly<{ kind: 'complete'; value: T }> | Readonly<{ kind: 'failure'; error: unknown }>
let packedAttempt: Attempt<NpmPackArtifact> | undefined
let installedPackageAttempt: Attempt<string> | undefined
const packScratch = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-pack-test-')))
const packedGitBin = join(packScratch, 'untrusted-bin')
const packedGitCanonical = join(packScratch, 'multicall-tool')
const systemGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
mkdirSync(packedGitBin)
writeFileSync(packedGitCanonical, `#!/bin/sh\nexec ${JSON.stringify(systemGit)} "$@"\n`, { mode: 0o700 })
symlinkSync(packedGitCanonical, join(packedGitBin, 'git'))

afterAll(() => rmSync(packScratch, { recursive: true, force: true }))

function npmEnvironment(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        PATH: `${packedGitBin}:${process.env.PATH ?? ''}`,
        npm_config_cache: join(packScratch, 'npm-cache'),
    }
}

function installedSetupFixture(name: string): {
    config: string
    siblingsRoot: string
    env: NodeJS.ProcessEnv
} {
    const estateRoot = join(packScratch, name)
    const mainCheckout = join(estateRoot, 'main')
    const siblingsRoot = join(estateRoot, 'siblings')
    const home = join(estateRoot, 'home')
    const state = join(estateRoot, 'state')
    mkdirSync(mainCheckout, { recursive: true })
    mkdirSync(siblingsRoot)
    mkdirSync(home)
    mkdirSync(state)
    execFileSync('git', ['init', '--quiet', mainCheckout])

    return {
        config: join(mainCheckout, 'cockpit.toml'),
        siblingsRoot,
        env: { ...npmEnvironment(), HOME: home, XDG_STATE_HOME: state },
    }
}

function packedArtifact(): NpmPackArtifact {
    if (packedAttempt?.kind === 'complete') return packedAttempt.value
    if (packedAttempt?.kind === 'failure') throw packedAttempt.error
    try {
        const isolatedRepository = join(packScratch, 'source')
        const isolatedPackage = join(isolatedRepository, 'packages', 'cockpit')
        mkdirSync(join(isolatedRepository, 'packages'), { recursive: true })
        for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) {
            copyFileSync(join(repoRoot, name), join(isolatedRepository, name))
        }
        cpSync(join(repoRoot, 'scripts'), join(isolatedRepository, 'scripts'), { recursive: true })
        cpSync(pkgDir, isolatedPackage, { recursive: true })
        const dependencies = dirname(dirname(fileURLToPath(import.meta.resolve('esbuild/package.json'))))
        symlinkSync(realpathSync(dependencies), join(isolatedRepository, 'node_modules'), 'dir')
        const destination = join(packScratch, 'artifact')
        mkdirSync(destination)
        const sourceCli = join(pkgDir, 'dist/cli.js')
        const sourceCliBefore = statSync(sourceCli, { bigint: true })
        // The supply-chain gate runs the real prepack lifecycle. This test consumes the already-built
        // artifact so its many installed-package assertions do not rebuild the package under suite load.
        const out = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
            cwd: isolatedPackage,
            env: npmEnvironment(),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 20_000,
        })
        const sourceCliAfter = statSync(sourceCli, { bigint: true })
        expect({ ino: sourceCliAfter.ino, mtimeNs: sourceCliAfter.mtimeNs }).toEqual({
            ino: sourceCliBefore.ino,
            mtimeNs: sourceCliBefore.mtimeNs,
        })
        const artifact = parseNpmPackJson(out)
        packedAttempt = Object.freeze({ kind: 'complete', value: artifact })
        return artifact
    } catch (error) {
        packedAttempt = Object.freeze({ kind: 'failure', error })
        throw error
    }
}

function packedFiles(): string[] {
    return packedArtifact().files.map((file) => file.path)
}

function packedPackageRoot(): string {
    if (installedPackageAttempt?.kind === 'complete') return installedPackageAttempt.value
    if (installedPackageAttempt?.kind === 'failure') throw installedPackageAttempt.error
    try {
        const destination = join(packScratch, 'artifact')
        const { filename } = packedArtifact()
        const installation = join(packScratch, 'installation')
        execFileSync(
            'npm',
            [
                'install',
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                '--no-package-lock',
                '--prefix',
                installation,
                join(destination, filename),
            ],
            { env: npmEnvironment(), stdio: ['ignore', 'ignore', 'ignore'], timeout: 30_000 },
        )
        const installedPackageRoot = join(installation, 'node_modules/@b00dea/cockpit')
        installedPackageAttempt = Object.freeze({ kind: 'complete', value: installedPackageRoot })
        return installedPackageRoot
    } catch (error) {
        installedPackageAttempt = Object.freeze({ kind: 'failure', error })
        throw error
    }
}

function read(relativeToRepoRoot: string): string {
    return readFileSync(join(repoRoot, relativeToRepoRoot), 'utf8')
}

describe('the published tarball carries only the consumer surface', { timeout: 40_000 }, () => {
    it('ships one private closed guard route without publishing it in help or reference surfaces', () => {
        const installed = packedPackageRoot()
        const launcher = join(installed, 'bin/cockpit.mjs')
        const options = { cwd: packScratch, env: npmEnvironment(), encoding: 'utf8' as const }
        const help = execFileSync(process.execPath, [launcher, '--help'], options)
        expect(help).not.toContain('guard-evaluate')
        const refusal = spawnSync(process.execPath, [launcher, 'guard-evaluate', '--harness', 'claudecode'], { ...options, input: '{}' })
        expect(refusal.status).toBe(0)
        expect(JSON.parse(refusal.stdout)).toEqual({ decision: 'unavailable', reason: expect.any(String) })
        // Human mode keeps stderr for diagnostics; the invocation record lives only in the --json envelope.
        expect(refusal.stderr).toBe('')
        expect(packedFiles().filter(path => path.endsWith('/guards/invocation-parser.js'))).toEqual(['dist/guards/invocation-parser.js'])
        expect(packedFiles().filter(path => path.endsWith('/guards/evaluator.js'))).toEqual(['dist/guards/evaluator.js'])
        for (const path of packedFiles().filter(path => path.startsWith('surfaces/') && /\.(md|json)$/.test(path))) {
            expect(readFileSync(join(installed, path), 'utf8'), path).not.toContain('guard-evaluate')
        }
    })

    // Packaging, installation and four fresh CLI processes share this aggregate budget.
    it('uses the installed producer for sync, check and version outside checkout', () => {
        const installed = packedPackageRoot()
        const actual = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
        expect(actual.engines.node).toBe(JSON.parse(read('package.json')).engines.node)
        const root = join(packScratch, 'producer-consumer')
        mkdirSync(join(root, 'app'), { recursive: true })
        const configPath = join(root, 'cockpit.toml')
        writeFileSync(configPath, read('fixtures/registries/generated-environment.toml').replace(
            'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
        ))
        const launcher = join(installed, 'bin/cockpit.mjs')
        const options = { cwd: packScratch, env: { ...npmEnvironment(), CI: '1' }, encoding: 'utf8' as const }
        const synchronized = execFileSync(process.execPath, [launcher, 'sync', '--config', configPath, '--json'], options)
        expect(JSON.parse(synchronized).result.changes).toEqual(expect.arrayContaining([
            { operation: 'write', path: 'package.json' },
            { operation: 'write', path: '.gitignore' },
        ]))
        expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toMatchObject({
            scripts: { 'cockpit:sync': 'cockpit sync --config cockpit.toml' },
            devDependencies: { [actual.name]: actual.version },
        })
        expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('# cockpit:ignore:start')
        execFileSync(process.execPath, [launcher, 'check', '--config', configPath, '--json'], options)
        const version = execFileSync(process.execPath, [launcher, '--version'], options)
        expect(version).toBe(`${actual.name} ${actual.version} (Node ${actual.engines.node}; source ${actual.cockpitSourceRevision})\n`)
        const parsed = execFileSync(process.execPath, ['--input-type=module', '--eval',
            `import { readFileSync } from 'node:fs'; import { parseOwnershipManifest } from ${JSON.stringify(pathToFileURL(join(installed, 'dist/surfaces/ownership.js')).href)};
            const bytes = readFileSync(${JSON.stringify(join(root, '.cockpit/generated-environment-ownership.json'))}, 'utf8');
            const result = parseOwnershipManifest(bytes, { root: ${JSON.stringify(root)}, configPath: ${JSON.stringify(configPath)}, cockpitId: JSON.parse(bytes).cockpitId });
            console.log(JSON.stringify(result));`,
        ], options)
        expect(JSON.parse(parsed)).toMatchObject({ kind: 'complete', manifest: { format: 'cockpit-generated-ownership/v3',
            producer: { package: actual.name, version: actual.version, sourceRevision: actual.cockpitSourceRevision } } })
    }, 120_000)

    it('refuses a stale schema artifact without rewriting it', () => {
        const scratch = mkdtempSync(join(tmpdir(), 'cockpit-stale-schema-'))
        const artifact = join(scratch, 'cockpit.schema.json')
        const stale = '{"stale":true}\n'
        try {
            writeFileSync(artifact, stale)

            expect(() =>
                execFileSync('npm', ['run', 'schema:check', '--', artifact], {
                    cwd: pkgDir,
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 20_000,
                }),
            ).toThrow(/COCKPIT_SCHEMA_STALE/)
            expect(readFileSync(artifact, 'utf8')).toBe(stale)
        } finally {
            rmSync(scratch, { recursive: true, force: true })
        }
    })

    it('ships no test file or test fixture', () => {
        // Tests name what the code must not do, which means they quote the material the
        // code exists to keep out. They are the last thing that should leave the repo.
        // Fixtures under src/ compile like source, so the build must exclude them too.
        expect(packedFiles().filter((f) => f.includes('.test.') || f.includes('/fixtures/'))).toEqual([])
    })

    it('ships exactly the inventory derived from production sources and explicit static assets', () => {
        expect([...packedFiles()].sort()).toEqual(expectedPackageFiles(repoRoot))
    })

    it('ships the surfaces, since an install without them cannot render a cockpit', () => {
        // The mirror of the check above: deny-by-default fails the other way too, and a
        // tarball that leaks nothing but renders nothing is equally broken.
        expect(packedFiles().some((f) => f.startsWith('surfaces/'))).toBe(true)
    })

    it('ships the user guide without contributor pages, and no shipped link leaves the installed copy', () => {
        // Rendered surfaces point agents at these pages; an agent offline, or one that cannot reach
        // the repository, has only what the installation carries.
        const files = packedFiles()
        expect(files).toEqual(expect.arrayContaining(['docs/README.md', 'docs/getting-started.md']))
        expect(files.filter((f) => f.startsWith('docs/contributing/'))).toEqual([])
        const installed = packedPackageRoot()
        const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0'))
        const source = 'https://github.com/b0dea/cockpit/blob/main/'
        const pages = files.filter((f) => f.startsWith('docs/') && f.endsWith('.md'))
        for (const page of pages) {
            const body = readFileSync(join(installed, page), 'utf8')
            // Fragments are checked on the source pages by lychee; the copy changes only link targets.
            const leaving = walkMarkdownProse(body).links.map(link => link.target.split('#', 1)[0]!)
                .filter(target => target !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(target))
                .filter(target => { const resolved = posix.join(posix.dirname(page), target); return !resolved.startsWith('docs/') || !existsSync(join(installed, resolved)) })
            expect(leaving, page).toEqual([])
            for (const [, path] of body.matchAll(/\]\(https:\/\/github\.com\/b0dea\/cockpit\/blob\/main\/([^)#\s]+)/g)) {
                expect(tracked.has(path!) || [...tracked].some((file) => file.startsWith(`${path}/`)), `${page} -> ${source}${path}`).toBe(true)
            }
            // The copy differs from the source only where a link leaving the guide was redirected,
            // never inside code: the configuration reference quotes schema patterns shaped like links.
            const original = readFileSync(join(repoRoot, page), 'utf8').split('\n')
            const changed = body.split('\n').flatMap((line, index) => line === original[index] ? [] : [[original[index], line]])
            expect(body.split('\n')).toHaveLength(original.length)
            for (const [before, after] of changed) {
                expect(before, page).toContain('](../')
                expect(after, page).toContain(`](${source}`)
            }
        }
    })

    it('ships every executable and editor artifact a consumer is owed', () => {
        expect(packedFiles()).toEqual(
            expect.arrayContaining([
                'bin/cockpit.mjs',
                'dist/cli.js',
                'dist/registry-resolve/command.js',
                'dist/registry-resolve/render-shell.js',
                'dist/environment/setup.js',
                'dist/environment/application.js',
                'dist/work-orders/application.js',
                'dist/work-orders/composition.js',
                'dist/browser/commands.js',
                'dist/testing/gates.js',
                'dist/environment/claims.js',
                'dist/environment/evidence.js',
                'dist/environment/lifecycle.js',
                'dist/environment/logs.js',
                'dist/environment/observations.js',
                'dist/environment/ports.js',
                'dist/environment/reclaim.js',
                'dist/environment/runtime.js',
                'dist/environment-exec/execute.js',
                'dist/generated-environment/command.js',
                'dist/surfaces/selftest.js',
                'dist/setup/command.js',
                'cockpit.schema.json',
                'libexec/browser-operation.cjs',
                'libexec/fence-marker.cjs',
                'libexec/fence-marker.d.cts',
                'libexec/fenced-group-runner.cjs',
                'libexec/fenced-supervisor.cjs',
                'libexec/generated-filesystem.cjs',
                'libexec/install-filesystem.cjs',
                'libexec/rulesync-generator.cjs',
                'libexec/rulesync-generator.NOTICE.md',
                'libexec/surface-generator-worker.cjs',
                'libexec/surface-output-reader.cjs',
                'libexec/surface-scratch-cleanup.cjs',
                'libexec/validate-harness-evidence.d.mts',
                'libexec/validate-harness-evidence.mjs',
                'surfaces/skills/cockpit-setup.skill.md',
                'surfaces/skills/collection.json',
                'surfaces/skills/cockpit-explain.skill.md',
                'surfaces/skills/cockpit-fix.skill.md',
                'surfaces/skills/cockpit-work.skill.md',
                'surfaces/skills/procedures/explain.md',
                'surfaces/skills/procedures/fix.md',
                'surfaces/skills/procedures/setup.md',
                'surfaces/skills/procedures/work.md',
                'surfaces/references/test-data-and-personas.md',
            ]),
        )
    })

    it('ships internal helpers without exposing another public command', () => {
        expect(packedFiles().filter((path) => path.startsWith('libexec/'))).toEqual([
            'libexec/browser-operation.cjs',
            'libexec/fence-marker.cjs',
            'libexec/fence-marker.d.cts',
            'libexec/fenced-group-runner.cjs',
            'libexec/fenced-supervisor.cjs',
            'libexec/generated-filesystem.cjs',
            'libexec/install-filesystem.cjs',
            'libexec/rulesync-generator.cjs',
            'libexec/rulesync-generator.NOTICE.md',
            'libexec/surface-generator-worker.cjs',
            'libexec/surface-output-reader.cjs',
            'libexec/surface-scratch-cleanup.cjs',
            'libexec/validate-harness-evidence.d.mts',
            'libexec/validate-harness-evidence.mjs',
        ])
        const manifest = JSON.parse(readFileSync(join(packedPackageRoot(), 'package.json'), 'utf8')) as { bin: unknown }
        expect(manifest.bin).toEqual({ cockpit: 'bin/cockpit.mjs' })
    })

    it('ships the authenticated generator with its complete build-time legal inventory', () => {
        const installed = packedPackageRoot()
        const bundle = readFileSync(join(installed, 'libexec/rulesync-generator.cjs'), 'utf8')
        const notice = readFileSync(join(installed, 'libexec/rulesync-generator.NOTICE.md'), 'utf8')
        const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
            dependencies: Record<string, string>
        }

        expect(Buffer.byteLength(bundle)).toBeGreaterThan(1_000_000)
        expect(notice.match(/^## /gm)).toHaveLength(38)
        expect(notice).toContain('## rulesync 43.1.2')
        expect(notice).toContain('SPDX license: MIT')
        expect(manifest.dependencies).not.toHaveProperty('rulesync')
        expect(existsSync(join(installed, '../../rulesync'))).toBe(false)
    })

    it('ships the filesystem helper as non-executable data for the resolved Node executable', () => {
        const helper = join(packedPackageRoot(), 'libexec/install-filesystem.cjs')
        const archiveRoot = join(packScratch, 'archive-mode')
        const archiveEntry = 'package/libexec/install-filesystem.cjs'
        mkdirSync(archiveRoot)
        execFileSync('/usr/bin/tar', [
            '-xzpf', join(packScratch, 'artifact', packedArtifact().filename),
            '-C', archiveRoot,
            archiveEntry,
        ])

        expect(statSync(join(archiveRoot, archiveEntry)).mode & 0o777).toBe(0o644)
        expect(statSync(helper).mode & 0o111).toBe(0)
        const direct = spawnSync(helper, [], { cwd: tmpdir(), encoding: 'utf8' })
        expect(direct.status).not.toBe(0)
        expect((direct.error as NodeJS.ErrnoException | undefined)?.code).toBe('EACCES')
    })

    it('runs the installed helper outside the checkout with a malformed control beside it', () => {
        const installed = packedPackageRoot()
        const helper = join(installed, 'libexec/install-filesystem.cjs')
        const root = join(packScratch, 'installed-helper-root')
        const hostileBin = join(packScratch, 'hostile-helper-bin')
        const marker = join(packScratch, 'hostile-node-ran')
        mkdirSync(root)
        mkdirSync(hostileBin)
        writeFileSync(join(hostileBin, 'node'), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 91\n`, { mode: 0o700 })
        const requestId = '11111111-1111-4111-8111-111111111111'
        const request = JSON.stringify({ version: 1, requestId, operation: 'ensure-directory', root, segments: ['cache'] })
        const options = { cwd: tmpdir(), encoding: 'utf8' as const, env: { ...process.env, PATH: hostileBin } }

        const valid = spawnSync(process.execPath, [helper, request], options)
        const broken = spawnSync(process.execPath, [helper, '{"version":1}'], options)
        const extraArgument = spawnSync(process.execPath, [helper, request, 'unexpected'], options)

        expect(valid.status).toBe(0)
        expect(valid.stderr).toBe('')
        expect(JSON.parse(valid.stdout)).toEqual({
            version: 1, requestId, kind: 'complete', path: join(root, 'cache'),
            dev: expect.any(Number), ino: expect.any(Number),
        })
        expect(valid.stdout).toBe(`${JSON.stringify(JSON.parse(valid.stdout))}\n`)
        expect(broken.status).toBe(2)
        expect(broken.stdout).toBe('')
        expect(broken.stderr).toContain('install-filesystem: invalid request envelope')
        expect(extraArgument.status).toBe(2)
        expect(extraArgument.stdout).toBe('')
        expect(extraArgument.stderr).toContain('install-filesystem:')
        expect(existsSync(marker)).toBe(false)
    })

    it('runs the packed CLI route without the maintainer checkout', () => {
        const launcher = join(packedPackageRoot(), 'bin/cockpit.mjs')
        const options = {
            cwd: tmpdir(),
            encoding: 'utf8',
        } as const

        const help = execFileSync(process.execPath, [launcher, '--help'], options)
        expect(help).toContain('registry-resolve')
        expect(help).toContain('sync              Write the Compose ownership override and agent files from cockpit.toml')
        expect(help).toContain('check             Report generated files that no longer match cockpit.toml')
        expect(help).toContain('selftest')
        const metadata = JSON.parse(readFileSync(join(packedPackageRoot(), 'package.json'), 'utf8'))
        expect(execFileSync(process.execPath, [launcher, '--version'], options)).toBe(
            `${metadata.name} ${metadata.version} (Node ${metadata.engines.node}; source ${metadata.cockpitSourceRevision})\n`,
        )
        // A packed source build is the install route before a release, so the resolver must work
        // on it and report the unstamped revision instead of refusing every input.
        const adoption = join(packScratch, 'adoption.state')
        writeFileSync(adoption, 'registry=migrated\nenvironment=documented-only\nsurfaces=documented-only\nguards=documented-only\ngrading=documented-only\n')
        const runResolver = (registry: string) => spawnSync(
            process.execPath,
            [launcher, 'registry-resolve', '--registry', registry, '--siblings-root', join(packScratch, 'siblings'), '--adoption', adoption],
            { ...options, encoding: 'utf8' },
        )
        const resolver = runResolver(join(repoRoot, 'fixtures/registries/tier-dialect.sh'))
        expect(resolver.status, resolver.stderr).toBe(0)
        expect(resolver.stdout).toContain(`COCKPIT_SOURCE_REVISION='${metadata.cockpitSourceRevision}'`)
        expect(resolver.stderr).toContain('COCKPIT_REVISION_UNSTAMPED')
        const malformed = runResolver(join(repoRoot, 'fixtures/registries/malformed.sh'))
        expect(malformed.status).toBe(2)
        expect(malformed.stdout).toBe('')
        expect(malformed.stderr).toContain('REGISTRY_ROW_SKIPPED')

        for (const command of ['sync', 'check', 'selftest', 'work status', 'work accept', 'work check', 'work note', 'work answer', 'work grade', 'work signoff', 'work recover', 'work verify', 'grade', 'browser drive', 'browser screenshot', 'test-run']) {
            const invalid = spawnSync(process.execPath, [launcher, ...command.split(' '), '--json'], options)
            expect(invalid.status).toBe(2)
            expect(invalid.stderr).toBe('')
            const envelope = JSON.parse(invalid.stdout)
            expect(Number.isSafeInteger(envelope.invocation.durationMs)).toBe(true)
            expect(envelope.invocation.durationMs).toBeGreaterThanOrEqual(0)
            expect(invalid.stdout.split('\n')).toHaveLength(2)
            expect(envelope).toEqual({
                invocation: { verb: command, durationMs: expect.any(Number), exitCode: invalid.status, resolvedConfigPath: null },
                result: null,
                diagnostics: [expect.objectContaining({ code: 'CLI_USAGE_INVALID', severity: 'error' })],
            })
        }
    })

    it('resolves the installed export, declarations, binary and licence', () => {
        const installed = packedPackageRoot()
        const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
            bin: Record<string, string>
            exports: Record<string, { import: string; types: string }>
            types: string
        }
        expect(manifest.bin).toEqual({ cockpit: 'bin/cockpit.mjs' })
        expect(manifest.types).toBe('./dist/cli.d.ts')
        expect(manifest.exports).toEqual({
            '.': { types: './dist/cli.d.ts', import: './dist/cli.js' },
        })
        expect(statSync(join(installed, manifest.types)).isFile()).toBe(true)
        expect(readFileSync(join(installed, 'LICENSE'), 'utf8')).toBe(read('LICENSE'))

        const imported = execFileSync(process.execPath, [
            '--input-type=module',
            '--eval',
            'import("@b00dea/cockpit").then(module => console.log(typeof module.runCli))',
        ], { cwd: dirname(dirname(dirname(installed))), encoding: 'utf8' })
        expect(imported).toBe('function\n')
    })

    it('runs manual wiring and report-only setup from the installed tarball', () => {
        const launcher = join(packedPackageRoot(), 'bin/cockpit.mjs')
        const { config, siblingsRoot, env } = installedSetupFixture('installed-setup')
        const manual = join(siblingsRoot, 'manual-repository')
        const data = join(siblingsRoot, 'local-data')
        mkdirSync(manual, { recursive: true })
        mkdirSync(data)
        execFileSync('git', ['init', '--quiet', manual])
        writeFileSync(config, [
            '[cockpit]', 'name = "installed-cockpit"', 'siblings_root = "../siblings"', '',
            '[[sibling]]', 'slug = "manual"', 'dir = "manual-repository"',
            'remote = "ssh://example.invalid/manual.git"', 'mount = "none"', 'acquire = "manual"',
            'var = "MANUAL_DIR"', 'purpose = "Synthetic manual repository"', '',
            '[[sibling]]', 'slug = "data"', 'dir = "local-data"', 'mount = "none"', 'acquire = "none"',
            'var = "DATA_DIR"', 'purpose = "Synthetic local data"', '',
            '[ports]', 'bases = { APP_PORT = 4100 }', '',
        ].join('\n'))
        const result = spawnSync(process.execPath, [launcher, 'setup', '--config', config, '--json'], {
            cwd: packScratch, encoding: 'utf8', env,
        })
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        expect(result.stderr).toBe('')
        const response = JSON.parse(result.stdout) as {
            result: {
                siblings: { action: string }[]
                execution: {
                    completedStepIds: string[]
                    mutationMayHaveOccurred: boolean
                    compensation: { attemptedStepIds: string[]; completedStepIds: string[]; failed: unknown[] }
                }
            }
        }
        expect(response.result.siblings.map(({ action }) => action)).toEqual(['report', 'report'])
        expect(response.result.execution).toEqual({
            completedStepIds: ['setup:manual:remote-add'],
            mutationMayHaveOccurred: true,
            compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
        })
        expect(execFileSync('git', ['-C', manual, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())
            .toBe('ssh://example.invalid/manual.git')
    })

    it.each([
        ['add', false],
        ['set-url', true],
    ])('keeps an option-like remote literal during packed manual %s', (_verb, existingOrigin) => {
        const launcher = join(packedPackageRoot(), 'bin/cockpit.mjs')
        const fixtureName = `manual-${existingOrigin ? 'set' : 'add'}-setup`
        const { config, siblingsRoot, env } = installedSetupFixture(fixtureName)
        const manual = join(siblingsRoot, 'manual-repository')
        mkdirSync(manual, { recursive: true })
        execFileSync('git', ['init', '--quiet', manual])
        if (existingOrigin) {
            execFileSync('git', ['-C', manual, 'remote', 'add', 'origin', 'ssh://example.invalid/old.git'])
        }
        const remote = '--add=synthetic.invalid/manual.git'
        writeFileSync(config, [
            '[cockpit]', 'name = "installed-cockpit"', 'siblings_root = "../siblings"', '',
            '[[sibling]]', 'slug = "manual"', 'dir = "manual-repository"',
            `remote = ${JSON.stringify(remote)}`, 'mount = "none"', 'acquire = "manual"',
            'var = "MANUAL_DIR"', 'purpose = "Synthetic manual repository"', '',
            '[ports]', 'bases = { APP_PORT = 4100 }', '',
        ].join('\n'))

        const result = spawnSync(process.execPath, [launcher, 'setup', '--config', config, '--json'], {
            cwd: packScratch, encoding: 'utf8', env, timeout: 10_000,
        })

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        expect(result.stderr).toBe('')
        expect(execFileSync('git', ['-C', manual, 'remote', 'get-url', '--', 'origin'], { encoding: 'utf8' }).trim())
            .toBe(remote)
    })

    it('keeps hostile remote and branch text as argv in the packed setup route', () => {
        const launcher = join(packedPackageRoot(), 'bin/cockpit.mjs')
        const source = join(packScratch, 'source.git;touch${IFS}remote-pwned')
        const { config, siblingsRoot, env } = installedSetupFixture('argv-setup')
        const target = join(siblingsRoot, 'api')
        const branch = 'main;touch${IFS}branch-pwned'
        mkdirSync(source)
        execFileSync('git', ['init', '--quiet', source])
        execFileSync('git', ['-C', source, 'config', 'user.name', 'Synthetic'])
        execFileSync('git', ['-C', source, 'config', 'user.email', 'synthetic@example.invalid'])
        writeFileSync(join(source, 'tracked'), 'safe')
        execFileSync('git', ['-C', source, 'add', 'tracked'])
        execFileSync('git', ['-C', source, 'commit', '--quiet', '-m', 'seed'])
        execFileSync('git', ['-C', source, 'branch', '-m', branch])
        writeFileSync(config, [
            '[cockpit]', 'name = "argv-cockpit"', 'siblings_root = "../siblings"', '',
            '[[sibling]]', 'slug = "api"', 'dir = "api"',
            `remote = ${JSON.stringify(source)}`, `branch = ${JSON.stringify(branch)}`,
            'mount = "always"', 'acquire = "auto"', 'var = "API_DIR"', 'purpose = "Synthetic API"', '',
            '[ports]', 'bases = { APP_PORT = 4100 }', '',
        ].join('\n'))

        const result = spawnSync(process.execPath, [launcher, 'setup', '--config', config, '--json'], {
            cwd: packScratch, encoding: 'utf8', env,
        })

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        expect(result.stderr).toBe('')
        expect(readFileSync(join(target, 'tracked'), 'utf8')).toBe('safe')
        expect(execFileSync('git', ['-C', target, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe(branch)
        expect(existsSync(join(siblingsRoot, 'remote-pwned'))).toBe(false)
        expect(existsSync(join(siblingsRoot, 'branch-pwned'))).toBe(false)
    })

    it('does not ship TypeScript sources or build configuration', () => {
        expect(packedFiles().some((f) => f.startsWith('src/'))).toBe(false)
        expect(packedFiles().some((f) => f.startsWith('dist/test-support/'))).toBe(false)
        expect(packedFiles()).not.toContain('tsconfig.build.json')
    })

    it('ships a licence text, which npm takes only from the package directory', () => {
        // The repository's own LICENSE is invisible to `npm pack` run from here. Until this
        // one existed the tarball claimed a licence in its manifest and carried no terms.
        expect(packedFiles()).toContain('LICENSE')
    })

    it('ships package guidance and exact source and support links', () => {
        expect(packedFiles()).toContain('README.md')
        // npm stopped packing CHANGELOG.md implicitly; upgraders read it from the installed package.
        expect(packedFiles()).toContain('CHANGELOG.md')
        expect(readFileSync(join(packedPackageRoot(), 'README.md'), 'utf8'))
            .toContain('https://github.com/b0dea/cockpit#readme')
        const manifest = JSON.parse(read('packages/cockpit/package.json'))
        expect({
            repository: manifest.repository,
            homepage: manifest.homepage,
            bugs: manifest.bugs,
        }).toEqual({
            repository: {
                type: 'git',
                url: 'git+https://github.com/b0dea/cockpit.git',
                directory: 'packages/cockpit',
            },
            homepage: 'https://github.com/b0dea/cockpit#readme',
            bugs: { url: 'https://github.com/b0dea/cockpit/issues' },
        })
    })

    it('ships the same licence the repository is published under', () => {
        // A copy rather than a symlink: probed 2026-08-25, npm drops a symlinked LICENSE
        // from the tarball silently, listed in `files` or not. Copies drift, so the copy is
        // pinned to the original here. Compared on disk because `--dry-run` reports paths,
        // not contents.
        expect(read('packages/cockpit/LICENSE')).toBe(read('LICENSE'))
    })

    it('declares an SPDX licence identifier rather than prose', () => {
        const manifest = JSON.parse(read('packages/cockpit/package.json'))
        expect(SPDX_IDS).toContain(manifest.license)
    })

    it('allows every direct runtime dependency and its licence deliberately', () => {
        const manifest = JSON.parse(read('packages/cockpit/package.json')) as {
            dependencies: Record<string, string>
        }
        const lock = JSON.parse(read('package-lock.json')) as {
            packages: Record<string, { license?: string }>
        }

        expect(Object.keys(manifest.dependencies).sort()).toEqual(
            Object.keys(RUNTIME_DEPENDENCY_LICENSES).sort(),
        )
        for (const [dependency, license] of Object.entries(RUNTIME_DEPENDENCY_LICENSES)) {
            expect(lock.packages[`node_modules/${dependency}`]?.license).toBe(license)
            expect(SPDX_IDS).toContain(license)
        }
    })

    it('stays unpublishable until publication is decided, not defaulted', () => {
        // The maintainer's explicit call: everything private through the internal trial on
        // real consumer repositories, and public only by a deliberate flip. `private: true`
        // is the one field npm itself refuses to publish past, which makes it the guard —
        // and this assertion is what makes removing it a decision someone sees in a diff
        // that fails CI, rather than a line lost in a release commit.
        const manifest = JSON.parse(read('packages/cockpit/package.json'))
        expect(manifest.private).toBe(true)
    })
})

it('keeps a verified local-archive pin through installed init, check and npm ci', () => {
    const requestedRoot = join(packScratch, 'source-install-init')
    mkdirSync(join(requestedRoot, 'library'), { recursive: true })
    const root = realpathSync(requestedRoot)
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({
        name: 'synthetic-cockpit-root', private: true, scripts: { lint: 'node --check synthetic.mjs' }, synthetic: { retained: true },
    }, null, 2)}\n`)
    writeFileSync(join(root, 'library/package.json'), `${JSON.stringify({
        name: 'synthetic-library', version: '0.0.0', scripts: { test: 'node test.mjs' },
    })}\n`)
    const answers = join(packScratch, 'source-install-answers.toml')
    writeFileSync(answers, [
        '[cockpit]', 'name = "synthetic"', '',
        '[[sibling]]', 'slug = "library"', 'dir = "library"', 'mount = "always"', 'acquire = "none"',
        'var = "LIBRARY_DIR"', 'purpose = "Synthetic library"', '', '[ports]', 'bases = {}', '',
        '[guards]', 'hosted_db_hosts = []', 'vendor_endpoint_hosts = []', '',
    ].join('\n'))
    const sourceArchive = join(packScratch, 'artifact', packedArtifact().filename)
    const home = join(packScratch, 'source-install-home')
    mkdirSync(home)
    const env = { ...npmEnvironment(), HOME: home, XDG_STATE_HOME: join(home, 'state') }
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', '--save-exact', sourceArchive], {
        cwd: root, env, stdio: 'ignore', timeout: 30_000,
    })
    const installedPin = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies['@b00dea/cockpit']
    expect(installedPin).toMatch(/^file:/)
    const installedLock = readFileSync(join(root, 'package-lock.json'), 'utf8')
    const launcher = join(root, 'node_modules/@b00dea/cockpit/bin/cockpit.mjs')
    const run = (...args: string[]) => {
        const result = spawnSync(process.execPath, [launcher, 'init', root, '--target', 'opencode', ...args, '--json'], {
            cwd: root, env, encoding: 'utf8', timeout: 30_000,
        })
        expect(result.error, JSON.stringify({ signal: result.signal, stdout: result.stdout, stderr: result.stderr })).toBeUndefined()
        return result
    }
    const first = run()
    expect(first.status, first.stdout + first.stderr).toBe(0)
    const preview = JSON.parse(first.stdout).result
    const second = run('--accept-preview', preview.previewSha256, '--answers', answers)
    expect(second.status, second.stdout + second.stderr).toBe(0)
    const defaults = JSON.parse(second.stdout).result.question
    expect(defaults).toMatchObject({ field: 'configuration.defaults' })
    const third = run('--accept-preview', preview.previewSha256, '--answers', answers, '--accept-defaults', defaults.expectedSha256)
    expect(third.status, third.stdout + third.stderr).toBe(0)
    expect(JSON.parse(third.stdout).result).toMatchObject({ stage: 'environment-verified' })

    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toMatchObject({
        name: 'synthetic-cockpit-root', private: true,
        scripts: { lint: 'node --check synthetic.mjs', 'cockpit:setup': 'cockpit setup --config cockpit.toml' },
        synthetic: { retained: true }, devDependencies: { '@b00dea/cockpit': installedPin },
    })
    expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(installedLock)
    const check = spawnSync(process.execPath, [launcher, 'check', '--config', join(root, 'cockpit.toml'), '--json'], {
        cwd: root, env, encoding: 'utf8', timeout: 30_000,
    })
    expect(check.status, check.stdout + check.stderr).toBe(0)
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: root, env, stdio: 'ignore', timeout: 30_000,
    })
}, 120_000)


// The installed-init cases share one HOME, as one operator's machine would; each case inits its own root.
// Together they took over 5 minutes at a load average of 20, so each keeps the bound the single case
// they were split from had: a loaded shared CI runner failed a correct run under a tighter one.
let installedInit: ReturnType<typeof prepareInstalledInit> | undefined
async function prepareInstalledInit() {
    const installed = packedPackageRoot(), launcher = join(installed, 'bin/cockpit.mjs')
    const home = join(packScratch, 'init-home')
    mkdirSync(home)
    const env = { ...npmEnvironment(), HOME: home, XDG_STATE_HOME: join(home, 'state') }
    const { runCli: installedCli } = await import(pathToFileURL(join(installed, 'dist/cli.js')).href)
    return { installed, launcher, env, installedCli }
}
const installedInitEnvironment = () => installedInit ??= prepareInstalledInit()

const initEstates = [
    { target: 'claudecode', classification: 'one-sibling', repositories: [{ slug: 'app', scripts: { start: 'node server.mjs' } }] },
    { target: 'codexcli', classification: 'no-runnable-product', repositories: [{ slug: 'library', scripts: { test: 'node test.mjs' } }] },
    { target: 'opencode', classification: 'ready-multi-repository', repositories: [
        { slug: 'api', scripts: { start: 'node server.mjs' } },
        { slug: 'web', scripts: { dev: 'node server.mjs' } },
    ] },
] as const

it.each(initEstates)('runs installed init on $target for a $classification estate and resumes it from its persisted answers', async (estate) => {
    const { launcher, env, installedCli } = await installedInitEnvironment()
    const { target, classification } = estate
    const requested = join(packScratch, `init-${classification}`)
    mkdirSync(requested)
    const root = realpathSync(requested)
    for (const repository of estate.repositories) {
        const directory = join(root, repository.slug)
        mkdirSync(directory)
        writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
            name: `synthetic-${repository.slug}`, version: '0.0.0', scripts: repository.scripts,
        })}\n`)
    }
    const preview = spawnSync(process.execPath, [launcher, 'init', root, '--target', target, '--json'], { cwd: root, env, encoding: 'utf8' })
    expect(preview.status, preview.stdout + preview.stderr).toBe(0)
    const result = JSON.parse(preview.stdout).result
    expect(result).toMatchObject({ root, target, stage: 'surface-previewed' })
    const prefix = target === 'claudecode' ? '.claude/skills/cockpit-setup/' : target === 'codexcli' ? '.agents/skills/cockpit-setup/' : '.opencode/skills/cockpit-setup/'
    expect(result.files.length).toBe(target === 'codexcli' ? 3 : 2)
    expect(result.files.every((file: { path: string }) => file.path.startsWith(prefix))).toBe(true)
    expect(existsSync(join(root, prefix))).toBe(false)
    let stdout = '', stderr = ''
    const questions: Array<{ field: string; expectedSha256?: string }> = []
    const status = await installedCli(['init', root, '--target', target, '--interactive'], {
        stdout: { write: (value: string) => ((stdout += value), true) }, stderr: { write: (value: string) => ((stderr += value), true) },
        confirmInit: async (shown: { previewSha256: string }) => shown.previewSha256,
        answerInitQuestion: async (question: { field: string; expectedSha256?: string }) => {
            questions.push(question)
            if (question.field === 'cockpit.name') return '"synthetic"'
            if (question.field === 'sibling') return JSON.stringify(estate.repositories.map(repository => ({
                slug: repository.slug, dir: repository.slug, mount: 'always', acquire: 'none',
                var: `${repository.slug.toUpperCase()}_DIR`, purpose: `Synthetic ${repository.slug} service`,
            })))
            if (question.field === 'ports.bases') return '{}'
            if (question.field === 'guards') return JSON.stringify({ hosted_db_hosts: [], vendor_endpoint_hosts: [] })
            if (question.field === 'environment.install_policies') return JSON.stringify([{
                toolchain: 'node', lockfile: 'package-lock.json', test: ['node', '--version'],
            }])
            if (question.field === 'environment.test_data') return JSON.stringify({ seeded_data: false, signed_in_users: false })
            // The interview now continues past the local test-data decision, so the fifth question is
            // reached; declining it leaves the target unwritten and the answers resumable. A
            // surfaces-only interview has no environment questions and reaches the defaults instead.
            if (question.field === 'environment.compose_files' || question.field === 'configuration.defaults') return undefined
            throw new Error(`unexpected installed init question: ${question.field}`)
        },
    }, {}, { env })
    for (const file of result.files) expect(existsSync(join(root, file.path))).toBe(true)
    for (const other of ['.claude', '.agents', '.opencode'].filter(value => !prefix.startsWith(value))) {
        expect(existsSync(join(root, other))).toBe(false)
    }
    expect(existsSync(join(root, 'cockpit.toml'))).toBe(false)
    if (classification === 'no-runnable-product') {
        expect(status, stderr).toBe(2)
        expect(stderr).toContain('GREENFIELD_ANSWER_REQUIRED')
        expect(questions.map(question => question.field)).toEqual(['cockpit.name', 'sibling', 'ports.bases', 'guards', 'configuration.defaults'])
        // The interactive answers are persisted, so a caller with no terminal finishes the same
        // init from the printed digests alone: it must not need a second interview.
        const pendingRun = spawnSync(process.execPath, [launcher, 'init', root, '--target', target, '--json'], { cwd: root, env, encoding: 'utf8' })
        expect(pendingRun.status, pendingRun.stderr).toBe(0)
        const printed = JSON.parse(pendingRun.stdout).result
        expect(printed.interview.outstanding.map((row: { field: string }) => row.field)).toEqual(['configuration.defaults'])
        const answersFile = join(root, '..', `${classification}-answers.toml`)
        writeFileSync(answersFile, '[ports]\nbases = {}\n')
        const finish = (...extra: string[]) => spawnSync(process.execPath, [launcher, 'init', root, '--target', target,
            '--accept-preview', printed.previewSha256, '--answers', answersFile, ...extra, '--json'], { cwd: root, env, encoding: 'utf8' })
        const awaiting = finish()
        expect(awaiting.status, awaiting.stderr).toBe(0)
        expect(JSON.parse(awaiting.stdout).result.question).toMatchObject({ field: 'configuration.defaults' })
        expect(existsSync(join(root, 'cockpit.toml'))).toBe(false)
        const wrong = finish('--accept-defaults', 'f'.repeat(64))
        expect(wrong.status).toBe(2)
        expect(JSON.parse(wrong.stdout).diagnostics[0].code).toBe('INIT_DEFAULTS_NOT_ACCEPTED')
        const done = finish('--accept-defaults', JSON.parse(awaiting.stdout).result.question.expectedSha256)
        expect(done.status, done.stdout + done.stderr).toBe(0)
        expect(JSON.parse(done.stdout).result).toMatchObject({ stage: 'environment-verified' })
        expect(JSON.parse(done.stdout).result).not.toHaveProperty('nextCommand')
        expect(readFileSync(join(root, 'cockpit.toml'), 'utf8')).toContain('[[sibling]]')
    } else {
        expect(status, stderr).toBe(2)
        expect(stderr).toContain('GREENFIELD_ANSWER_REQUIRED')
        expect(questions.map(question => question.field)).toEqual([
            'cockpit.name', 'sibling', 'ports.bases', 'environment.install_policies', 'environment.test_data', 'environment.compose_files',
        ])
        const resumed = spawnSync(process.execPath, [launcher, 'init', root, '--target', target, '--json'], {
            cwd: root, env, encoding: 'utf8',
        })
        expect(resumed.status, resumed.stderr).toBe(0)
        expect(JSON.parse(resumed.stdout).result).toMatchObject({
            estate: { classification },
            question: { field: 'environment.compose_files' },
        })
    }
}, 480_000)

it('discards answers inferred for an estate that changes from no runnable product to one sibling', async () => {
    const { launcher, env } = await installedInitEnvironment()
    const changingRequested = join(packScratch, 'init-no-runnable-to-runnable')
    mkdirSync(changingRequested)
    const changingRoot = realpathSync(changingRequested)
    const changingRepository = join(changingRoot, 'library')
    mkdirSync(changingRepository)
    const changingManifest = join(changingRepository, 'package.json')
    writeFileSync(changingManifest, `${JSON.stringify({
        name: 'synthetic-changing-library', version: '0.0.0', scripts: { test: 'node test.mjs' },
    })}\n`)
    const changingAnswers = join(packScratch, 'changing-estate-answers.toml')
    writeFileSync(changingAnswers, [
        '[cockpit]', 'name = "synthetic"', '',
        '[[sibling]]', 'slug = "library"', 'dir = "library"', 'mount = "always"', 'acquire = "none"',
        'var = "LIBRARY_DIR"', 'purpose = "Synthetic changing service"', '',
    ].join('\n'))
    const changingRun = (...args: string[]) => spawnSync(process.execPath,
        [launcher, 'init', changingRoot, '--target', 'codexcli', ...args, '--json'],
        { cwd: changingRoot, env, encoding: 'utf8' })
    const changingFirst = changingRun()
    expect(changingFirst.status, changingFirst.stdout + changingFirst.stderr).toBe(0)
    const changingPreview = JSON.parse(changingFirst.stdout).result
    const changingPending = changingRun('--accept-preview', changingPreview.previewSha256, '--answers', changingAnswers)
    expect(changingPending.status, changingPending.stdout + changingPending.stderr).toBe(0)
    expect(JSON.parse(changingPending.stdout).result).toMatchObject({
        estate: { classification: 'no-runnable-product', answers: [expect.objectContaining({ provenance: 'operator-confirmed' }),
            expect.objectContaining({ provenance: 'operator-confirmed' })] },
        question: { field: 'ports.bases' },
    })

    writeFileSync(changingManifest, `${JSON.stringify({
        name: 'synthetic-changing-library', version: '0.0.0', scripts: { start: 'node server.mjs' },
    })}\n`)
    const changedPreviewRun = changingRun()
    expect(changedPreviewRun.status, changedPreviewRun.stdout + changedPreviewRun.stderr).toBe(0)
    const changedPreview = JSON.parse(changedPreviewRun.stdout).result
    expect(changedPreview).toMatchObject({
        estate: { classification: 'one-sibling', answers: [] }, interview: { answered: [] },
    })
    expect(changedPreview).not.toHaveProperty('question')
    const changedAccepted = changingRun('--accept-preview', changedPreview.previewSha256, '--answers', changingAnswers)
    expect(changedAccepted.status, changedAccepted.stdout + changedAccepted.stderr).toBe(0)
    const refreshed = JSON.parse(changedAccepted.stdout).result
    expect(refreshed).toMatchObject({
        estate: { classification: 'one-sibling', answers: [expect.objectContaining({ provenance: 'operator-confirmed' }),
            expect.objectContaining({ provenance: 'operator-confirmed' })] },
        question: { field: 'ports.bases' },
    })
}, 480_000)

it('lists every outstanding headless init question with the values it inferred', async () => {
    const { launcher, env } = await installedInitEnvironment()
    mkdirSync(join(packScratch, 'init-headless'))
    const headless = realpathSync(join(packScratch, 'init-headless'))
    mkdirSync(join(headless, 'library'))
    writeFileSync(join(headless, 'library/package.json'), `${JSON.stringify({ name: 'synthetic-library', version: '0.0.0', scripts: { test: 'node test.mjs' } })}\n`)
    writeFileSync(join(headless, 'library/Dockerfile'), 'FROM node:22-slim\nEXPOSE 4100\nCMD ["node", "index.mjs"]\n')
    const run = (...args: string[]) => spawnSync(process.execPath, [launcher, 'init', headless, '--target', 'opencode', ...args, '--json'],
        { cwd: headless, env, encoding: 'utf8' })
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    const listed = JSON.parse(first.stdout).result
    expect(listed.interview.outstanding.map((row: { field: string }) => row.field)).toEqual([
        'cockpit.name', 'sibling', 'ports.bases', 'environment.install_policies', 'environment.test_data',
        'environment.compose_files', 'environment.machine', 'environment.posture', 'testing', 'guards', 'configuration.defaults',
    ])
    expect(listed.interview.outstanding.find((row: { field: string }) => row.field === 'ports.bases').inferred).toEqual([
        expect.objectContaining({ target: 'library.container_ports', value: [4100], provenance: expect.objectContaining({ kind: 'inferred', source: 'library/Dockerfile' }) }),
    ])
    expect(listed.interview.outstanding.find((row: { field: string }) => row.field === 'testing').inferred).toEqual([
        expect.objectContaining({ target: 'testing.library', provenance: expect.objectContaining({ kind: 'inferred', source: 'library/package.json' }) }),
    ])
}, 480_000)

it('finishes init across three runs without a terminal and lets a teammate clone set up, sync and check', async () => {
    const { launcher, env } = await installedInitEnvironment()
    const answersFile = join(packScratch, 'headless-answers.toml')
    writeFileSync(answersFile, [
        '[cockpit]', 'name = "synthetic"', '',
        '[[sibling]]', 'slug = "library"', 'dir = "library"', 'mount = "always"', 'acquire = "none"',
        'var = "LIBRARY_DIR"', 'purpose = "Synthetic library"', '', '[ports]', 'bases = {}', '',
        '[guards]', 'hosted_db_hosts = []', 'vendor_endpoint_hosts = []', ''].join('\n'))
    // An agent has no terminal at any point: three runs, each given only what the previous one printed.
    const portableRequested = join(packScratch, 'init-portable')
    mkdirSync(portableRequested)
    const portable = realpathSync(portableRequested)
    mkdirSync(join(portable, 'library'))
    writeFileSync(join(portable, 'library/package.json'), `${JSON.stringify({ name: 'synthetic-library', version: '0.0.0', scripts: { test: 'node test.mjs' } })}\n`)
    const portableRun = (...args: string[]) => spawnSync(process.execPath, [launcher, 'init', portable, '--target', 'opencode', ...args, '--json'],
        { cwd: portable, env, encoding: 'utf8' })
    const portableFirst = portableRun()
    expect(portableFirst.status, portableFirst.stderr).toBe(0)
    const portableListed = JSON.parse(portableFirst.stdout).result
    expect(portableListed.interview.outstanding.map((row: { field: string }) => row.field)).toEqual([
        'cockpit.name', 'sibling', 'ports.bases', 'guards', 'configuration.defaults',
    ])
    const second = portableRun('--accept-preview', portableListed.previewSha256, '--answers', answersFile)
    expect(second.status, second.stderr).toBe(0)
    const defaults = JSON.parse(second.stdout).result.question
    expect(defaults).toMatchObject({ field: 'configuration.defaults' })
    const third = portableRun('--accept-preview', portableListed.previewSha256, '--answers', answersFile, '--accept-defaults', defaults.expectedSha256)
    expect(third.status, third.stdout + third.stderr).toBe(0)
    expect(JSON.parse(third.stdout).result).toMatchObject({ stage: 'environment-verified' })
    expect(existsSync(join(portable, 'cockpit.toml'))).toBe(true)

    // A teammate's clone has a different checkout path and HOME. The local tarball stands in for
    // the registry artifact while package.json retains the exact published version a real team
    // commits; npm's lockfile records where this test can fetch those same bytes.
    writeFileSync(join(portable, 'cockpit.toml'), readFileSync(join(portable, 'cockpit.toml'), 'utf8')
        .replace('dir = "library"', 'dir = "."'))
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', '--save-exact',
        join(packScratch, 'artifact', packedArtifact().filename)], { cwd: portable, env, stdio: 'ignore', timeout: 30_000 })
    const teamPackage = JSON.parse(readFileSync(join(portable, 'package.json'), 'utf8'))
    teamPackage.devDependencies['@b00dea/cockpit'] = cockpitPackageVersion
    writeFileSync(join(portable, 'package.json'), `${JSON.stringify(teamPackage, null, 2)}\n`)
    const teamLock = JSON.parse(readFileSync(join(portable, 'package-lock.json'), 'utf8'))
    teamLock.packages[''].devDependencies['@b00dea/cockpit'] = cockpitPackageVersion
    writeFileSync(join(portable, 'package-lock.json'), `${JSON.stringify(teamLock, null, 2)}\n`)
    const preparedTeam = spawnSync(process.execPath, [launcher, 'sync', '--config', join(portable, 'cockpit.toml'), '--json'], {
        cwd: portable, env, encoding: 'utf8', timeout: 30_000,
    })
    expect(preparedTeam.status, preparedTeam.stdout + preparedTeam.stderr).toBe(0)
    execFileSync('git', ['init', '--quiet', portable])
    execFileSync('git', ['-C', portable, 'add', '.'])
    execFileSync('git', ['-C', portable, '-c', 'user.name=Synthetic Maintainer', '-c', 'user.email=maintainer@example.test',
        'commit', '--quiet', '-m', 'Add synthetic cockpit'])
    const teammatePath = join(packScratch, 'teammate-clone')
    const teammateHome = join(packScratch, 'teammate-home')
    mkdirSync(teammateHome)
    execFileSync('git', ['clone', '--quiet', portable, teammatePath])
    const teammate = realpathSync(teammatePath)
    const teammateEnv = { ...env, HOME: teammateHome, XDG_STATE_HOME: join(teammateHome, 'state'),
        GIT_CONFIG_GLOBAL: join(teammateHome, 'missing-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: teammate, env: teammateEnv, stdio: 'ignore', timeout: 30_000,
    })
    const teammateLauncher = join(teammate, 'node_modules/@b00dea/cockpit/bin/cockpit.mjs')
    for (const command of ['setup', 'sync', 'check']) {
        const result = spawnSync(process.execPath, [teammateLauncher, command, '--config', join(teammate, 'cockpit.toml'), '--json'], {
            cwd: teammate, env: teammateEnv, encoding: 'utf8', timeout: 30_000,
        })
        expect(result.status, `${command}: ${result.stdout}${result.stderr}`).toBe(0)
    }
    expect(execFileSync('git', ['-C', teammate, 'status', '--porcelain'], { encoding: 'utf8', env: teammateEnv })).toBe('')
}, 480_000)

it('refuses init without a root or with a broken adjacent asset and writes nothing', async () => {
    const { installed, launcher, env } = await installedInitEnvironment()
    const untouched = join(packScratch, 'init-missing-root')
    mkdirSync(untouched)
    const missing = spawnSync(process.execPath, [launcher, 'init', '--target', 'codexcli', '--json'], { cwd: untouched, env, encoding: 'utf8' })
    expect(missing.status).toBe(2)
    expect(existsSync(join(untouched, '.agents'))).toBe(false)
    const asset = join(installed, 'surfaces/skills/cockpit-setup.skill.md'), bytes = readFileSync(asset)
    try {
        writeFileSync(asset, 'broken adjacent asset')
        const broken = spawnSync(process.execPath, [launcher, 'init', untouched, '--target', 'codexcli', '--json'], { cwd: untouched, env, encoding: 'utf8' })
        expect(broken.status).toBe(2)
        expect(JSON.parse(broken.stdout).diagnostics.length).toBeGreaterThan(0)
        expect(existsSync(join(untouched, '.agents'))).toBe(false)
    } finally { writeFileSync(asset, bytes) }
}, 480_000)


it.each(['dedicated', 'in-repo'] as const)('finishes installed init for a product using the %s cockpit root', rootChoice => {
    const launcher = join(packedPackageRoot(), 'bin/cockpit.mjs')
    const parent = join(packScratch, `product-${rootChoice}`)
    const product = join(parent, 'store')
    const home = join(parent, 'home')
    mkdirSync(product, { recursive: true })
    mkdirSync(home)
    execFileSync('git', ['init', '--quiet', product])
    const productManifest = { name: 'synthetic-store', version: '0.0.0', scripts: { test: 'node test.mjs' } }
    const manifest = `${JSON.stringify(productManifest)}\n`
    writeFileSync(join(product, 'package.json'), manifest)
    const root = rootChoice === 'dedicated' ? `${product}-cockpit` : product
    const answers = join(parent, 'answers.toml')
    writeFileSync(answers, [
        '[cockpit]', `root = "${rootChoice}"`, 'name = "synthetic-store"', '',
        '[[sibling]]', 'slug = "store"', `dir = "${rootChoice === 'dedicated' ? 'store' : '.'}"`,
        'mount = "none"', 'acquire = "none"', 'var = "STORE_DIR"', 'purpose = "Synthetic store library"', '',
        '[ports]', 'bases = {}', '', '[guards]', 'hosted_db_hosts = []', 'vendor_endpoint_hosts = []', '',
    ].join('\n'))
    const env = { ...npmEnvironment(), HOME: home, XDG_STATE_HOME: join(home, 'state') }
    const run = (...extra: string[]) => spawnSync(process.execPath, [launcher, 'init', product, '--target', 'codexcli',
        ...extra, '--json'], { cwd: product, env, encoding: 'utf8' })
    const preview = run()
    expect(preview.status, preview.stdout + preview.stderr).toBe(0)
    const shown = JSON.parse(preview.stdout).result
    const pending = run('--accept-preview', shown.previewSha256, '--answers', answers)
    expect(pending.status, pending.stdout + pending.stderr).toBe(0)
    const defaults = JSON.parse(pending.stdout).result.question
    expect(defaults).toMatchObject({ field: 'configuration.defaults' })
    const completed = run('--accept-preview', shown.previewSha256, '--answers', answers, '--accept-defaults', defaults.expectedSha256)
    expect(completed.status, completed.stdout + completed.stderr).toBe(0)
    expect(JSON.parse(completed.stdout).result).toMatchObject({ root, stage: 'environment-verified' })
    expect(statSync(join(root, '.git')).isDirectory()).toBe(true)
    const completedManifest = readFileSync(join(product, 'package.json'), 'utf8')
    if (rootChoice === 'dedicated') expect(completedManifest).toBe(manifest)
    else expect(JSON.parse(completedManifest)).toEqual({
        ...productManifest,
        scripts: {
            ...productManifest.scripts,
            'cockpit:setup': 'cockpit setup --config cockpit.toml',
            'cockpit:sync': 'cockpit sync --config cockpit.toml',
            'cockpit:check': 'cockpit check --config cockpit.toml',
        },
        devDependencies: { '@b00dea/cockpit': cockpitPackageVersion },
    })
    expect(readFileSync(join(root, 'cockpit.toml'), 'utf8')).toContain(`dir = "${rootChoice === 'dedicated' ? 'store' : '.'}"`)
    const check = spawnSync(process.execPath, [launcher, 'check', '--config', join(root, 'cockpit.toml'), '--json'],
        { cwd: root, env, encoding: 'utf8' })
    expect(check.status, check.stdout + check.stderr).toBe(0)
}, 180_000)
