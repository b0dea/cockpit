import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parseNpmPackJson, type NpmPackArtifact } from './test-support/npm-pack-json.js'
import { expectedPackageFiles } from '../../../scripts/supply-chain-check.mjs'

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
        const installedPackageRoot = join(installation, 'node_modules/@b0dea/cockpit')
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
        const root = join(packScratch, 'producer-consumer')
        mkdirSync(join(root, 'app'), { recursive: true })
        mkdirSync(join(root, 'fixtures'))
        writeFileSync(join(root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
        const configPath = join(root, 'cockpit.toml')
        writeFileSync(configPath, read('fixtures/registries/generated-environment.toml').replace(
            'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
        ))
        const launcher = join(installed, 'bin/cockpit.mjs')
        const options = { cwd: packScratch, env: { ...npmEnvironment(), CI: '1' }, encoding: 'utf8' as const }
        execFileSync(process.execPath, [launcher, 'sync', '--config', configPath, '--json'], options)
        execFileSync(process.execPath, [launcher, 'check', '--config', configPath, '--json'], options)
        const actual = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
        const version = execFileSync(process.execPath, [launcher, '--version'], options)
        expect(version).toBe(`${actual.name} ${actual.version} (Node ${actual.engines.node}; source ${actual.cockpitSourceRevision})\n`)
        const parsed = execFileSync(process.execPath, ['--input-type=module', '--eval',
            `import { readFileSync } from 'node:fs'; import { parseOwnershipManifest } from ${JSON.stringify(pathToFileURL(join(installed, 'dist/surfaces/ownership.js')).href)};
            const bytes = readFileSync(${JSON.stringify(join(root, '.cockpit/generated-environment-ownership.json'))}, 'utf8');
            const result = parseOwnershipManifest(bytes, { root: ${JSON.stringify(root)}, configPath: ${JSON.stringify(configPath)}, cockpitId: JSON.parse(bytes).cockpitId });
            console.log(JSON.stringify(result));`,
        ], options)
        expect(JSON.parse(parsed)).toMatchObject({ kind: 'complete', manifest: { format: 'cockpit-generated-ownership/v3',
            producer: { package: actual.name, version: actual.version, sourceRevision: actual.cockpitSourceRevision, producedAt: expect.any(String) } } })
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

    it('packs a non-trivial number of files — an empty pack passes trivially', () => {
        expect(packedFiles().length).toBeGreaterThan(3)
    })

    it('ships no test file', () => {
        // Tests name what the code must not do, which means they quote the material the
        // code exists to keep out. They are the last thing that should leave the repo.
        expect(packedFiles().filter((f) => f.includes('.test.'))).toEqual([])
    })

    it('ships exactly the inventory derived from production sources and explicit static assets', () => {
        expect([...packedFiles()].sort()).toEqual(expectedPackageFiles(repoRoot))
    })

    it('ships the surfaces, since an install without them cannot render a cockpit', () => {
        // The mirror of the check above: deny-by-default fails the other way too, and a
        // tarball that leaks nothing but renders nothing is equally broken.
        expect(packedFiles().some((f) => f.startsWith('surfaces/'))).toBe(true)
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
                'dist/selftest/command.js',
                'dist/surfaces/selftest.js',
                'dist/upgrade/command.js',
                'dist/setup/command.js',
                'dist/up/command.js',
                'dist/sleep/command.js',
                'dist/down/command.js',
                'dist/reset/command.js',
                'dist/preflight/command.js',
                'dist/doctor/command.js',
                'dist/logs/command.js',
                'dist/baseline/command.js',
                'cockpit.schema.json',
                'libexec/install-filesystem.cjs',
                'libexec/rulesync-generator.cjs',
                'libexec/rulesync-generator.NOTICE.md',
                'libexec/validate-harness-evidence.d.mts',
                'libexec/validate-harness-evidence.mjs',
                'surfaces/skills/cockpit-setup.skill.md',
                'surfaces/skills/collection.json',
                'surfaces/skills/cockpit-explain.skill.md',
                'surfaces/skills/cockpit-fix.skill.md',
                'surfaces/skills/cockpit-work.skill.md',
                'surfaces/skills/procedures/onboarding.md',
            ]),
        )
    })

    it('ships internal helpers without exposing another public command', () => {
        expect(packedFiles().filter((path) => path.startsWith('libexec/'))).toEqual([
            'libexec/install-filesystem.cjs',
            'libexec/rulesync-generator.cjs',
            'libexec/rulesync-generator.NOTICE.md',
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
        expect(notice).toContain('## rulesync 40.2.0')
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
        expect(help).toContain('sync                   Synchronize canonical generated environment files')
        expect(help).toContain('check                  Check canonical generated environment files for drift')
        expect(help).toContain('selftest')
        expect(help).toContain('upgrade')
        expect(execFileSync(process.execPath, [launcher, '--version'], options)).toBe(
            '@b0dea/cockpit 0.0.0 (Node >=22; source development)\n',
        )
        const resolver = spawnSync(
            process.execPath,
            [
                launcher,
                'registry-resolve',
                '--registry',
                join(packScratch, 'missing-registry'),
                '--siblings-root',
                join(packScratch, 'siblings'),
                '--adoption',
                join(packScratch, 'missing-adoption'),
            ],
            { ...options, encoding: 'utf8' },
        )
        expect(resolver.status).toBe(2)
        expect(resolver.stdout).toBe('')
        expect(resolver.stderr).toContain('COCKPIT_REVISION_INVALID')

        for (const command of ['sync', 'check', 'selftest', 'upgrade', 'work-intake', 'work-status', 'work-accept', 'work-renew', 'work-resume', 'work-execute', 'work-record', 'work-review', 'work-sweep', 'work-reverse', 'work-programme-mint', 'work-metrics', 'work-grade', 'browser-drive', 'browser-accessibility', 'browser-screenshot', 'browser-debugger', 'test-run']) {
            const invalid = spawnSync(process.execPath, [launcher, command, '--json'], options)
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
            'import("@b0dea/cockpit").then(module => console.log(typeof module.runCli))',
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

    it('proves it can fail, on a control the tarball does not contain', () => {
        const files = packedFiles()
        expect(files.some((f) => f.includes('.test.'))).toBe(false)
        expect(['src/schema.ts', 'src/x.test.ts'].some((f) => f.includes('.test.'))).toBe(true)
    })

    it('ships a licence text, which npm takes only from the package directory', () => {
        // The repository's own LICENSE is invisible to `npm pack` run from here. Until this
        // one existed the tarball claimed a licence in its manifest and carried no terms.
        expect(packedFiles()).toContain('LICENSE')
    })

    it('ships package guidance and exact source and support links', () => {
        expect(packedFiles()).toContain('README.md')
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

it('runs installed comparison validation and ledger status outside the source checkout', () => {
    const installed = packedPackageRoot()
    const root = join(packScratch, 'comparison-consumer')
    mkdirSync(root)
    writeFileSync(join(root, 'comparison.json'), readFileSync(join(repoRoot, 'fixtures/comparison/command-set.json')))
    writeFileSync(join(root, 'ledger.json'), '{}')
    const launcher = join(installed, 'bin/cockpit.mjs')
    const options = { cwd: root, env: npmEnvironment(), encoding: 'utf8' as const }
    const valid = spawnSync(process.execPath, [launcher, 'compare', 'validate', '--fixture', 'comparison.json', '--json'], options)
    expect(valid.status, valid.stderr).toBe(0)
    expect(JSON.parse(valid.stdout).result).toEqual({ fixtureId: 'synthetic-parity', operatorGates: 'held' })
    expect(valid.stdout.trim().split('\n')).toHaveLength(1)
    const status = spawnSync(process.execPath, [launcher, 'compare', 'status', '--fixture', 'comparison.json', '--ledger', 'ledger.json', '--json'], options)
    expect(status.status, status.stderr).toBe(2)
    expect(JSON.parse(status.stdout).result).toMatchObject({ verdict: 'DEGRADED', satisfiesGate: false })
    expect(readFileSync(join(root, 'ledger.json'), 'utf8')).toBe('{}')
    const forbidden = spawnSync(process.execPath, [launcher, 'compare', 'validate', '--fixture', 'comparison.json', '--config', 'cockpit.toml', '--json'], options)
    expect(forbidden.status).toBe(2)
    expect(JSON.parse(forbidden.stdout).diagnostics[0].code).toBe('CLI_USAGE_INVALID')
}, 120_000)


it('runs installed init for each isolated target and refuses missing roots or broken adjacent assets', async () => {
    const installed = packedPackageRoot(), launcher = join(installed, 'bin/cockpit.mjs')
    const home = join(packScratch, 'init-home')
    mkdirSync(home)
    const env = { ...npmEnvironment(), HOME: home, XDG_STATE_HOME: join(home, 'state') }
    const { runCli: installedCli } = await import(pathToFileURL(join(installed, 'dist/cli.js')).href)
    const estates = [
        { target: 'claudecode', classification: 'one-sibling', repositories: [{ slug: 'app', scripts: { start: 'node server.mjs' } }] },
        { target: 'codexcli', classification: 'no-runnable-product', repositories: [{ slug: 'library', scripts: { test: 'node test.mjs' } }] },
        { target: 'opencode', classification: 'ready-multi-repository', repositories: [
            { slug: 'api', scripts: { start: 'node server.mjs' } },
            { slug: 'web', scripts: { dev: 'node server.mjs' } },
        ] },
    ] as const
    for (const estate of estates) {
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
                if (question.field === 'sibling') return JSON.stringify(estate.repositories.map(repository => ({
                    slug: repository.slug, dir: repository.slug, mount: 'always', acquire: 'none',
                    var: `${repository.slug.toUpperCase()}_DIR`, purpose: `Synthetic ${repository.slug} service`,
                })))
                if (question.field === 'ports.bases') return '{}'
                if (question.field === 'guards') return JSON.stringify({ hosted_db_hosts: [], vendor_endpoint_hosts: [] })
                if (question.field === 'environment.install_policies') return JSON.stringify([{
                    toolchain: 'node', volume: 'dependencies', lockfile: 'package-lock.json',
                    install: ['npm', 'ci'], load_probe: ['node', '--version'],
                }])
                // The interview now continues past the policy question, so the fourth question is
                // reached; declining it leaves the target unwritten and the answers resumable. A
                // surfaces-only interview has no environment questions and reaches the defaults instead.
                if (question.field === 'environment.generated' || question.field === 'configuration.defaults') return undefined
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
            expect(questions.map(question => question.field)).toEqual(['sibling', 'ports.bases', 'guards', 'configuration.defaults'])
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
            expect(JSON.parse(done.stdout).result).toMatchObject({ stage: 'environment-verified', nextCommand: 'bootstrap complete' })
            expect(readFileSync(join(root, 'cockpit.toml'), 'utf8')).toContain('[[sibling]]')
        } else {
            expect(status, stderr).toBe(2)
            expect(stderr).toContain('GREENFIELD_ANSWER_REQUIRED')
            expect(questions.map(question => question.field)).toEqual([
                'sibling', 'ports.bases', 'environment.install_policies', 'environment.generated',
            ])
            const resumed = spawnSync(process.execPath, [launcher, 'init', root, '--target', target, '--json'], {
                cwd: root, env, encoding: 'utf8',
            })
            expect(resumed.status, resumed.stderr).toBe(0)
            expect(JSON.parse(resumed.stdout).result).toMatchObject({
                estate: { classification },
                question: { field: 'environment.generated' },
            })
        }
    }
    // An agent has no terminal at any point: three runs, each given only what the previous one printed.
    mkdirSync(join(packScratch, 'init-headless'))
    const headless = realpathSync(join(packScratch, 'init-headless'))
    mkdirSync(join(headless, 'library'))
    writeFileSync(join(headless, 'library/package.json'), `${JSON.stringify({ name: 'synthetic-library', version: '0.0.0', scripts: { test: 'node test.mjs' } })}\n`)
    writeFileSync(join(headless, 'library/Dockerfile'), 'FROM node:22-slim\nEXPOSE 4100\nCMD ["node", "index.mjs"]\n')
    const answersFile = join(packScratch, 'headless-answers.toml')
    writeFileSync(answersFile, [
        '[[sibling]]', 'slug = "library"', 'dir = "library"', 'mount = "always"', 'acquire = "none"',
        'var = "LIBRARY_DIR"', 'purpose = "Synthetic library"', '', '[ports]', 'bases = {}', '',
        '[guards]', 'hosted_db_hosts = []', 'vendor_endpoint_hosts = []', ''].join('\n'))
    const run = (...args: string[]) => spawnSync(process.execPath, [launcher, 'init', headless, '--target', 'opencode', ...args, '--json'],
        { cwd: headless, env, encoding: 'utf8' })
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    const listed = JSON.parse(first.stdout).result
    expect(listed.interview.outstanding.map((row: { field: string }) => row.field)).toEqual(['sibling', 'ports.bases', 'guards', 'configuration.defaults'])
    expect(listed.interview.outstanding.find((row: { field: string }) => row.field === 'ports.bases').inferred).toEqual([
        expect.objectContaining({ target: 'library.container_ports', value: [4100], provenance: expect.objectContaining({ kind: 'inferred', source: 'library/Dockerfile' }) }),
    ])
    const second = run('--accept-preview', listed.previewSha256, '--answers', answersFile)
    expect(second.status, second.stderr).toBe(0)
    const defaults = JSON.parse(second.stdout).result.question
    expect(defaults).toMatchObject({ field: 'configuration.defaults' })
    const third = run('--accept-preview', listed.previewSha256, '--answers', answersFile, '--accept-defaults', defaults.expectedSha256)
    expect(third.status, third.stdout + third.stderr).toBe(0)
    expect(JSON.parse(third.stdout).result).toMatchObject({ stage: 'environment-verified' })
    expect(existsSync(join(headless, 'cockpit.toml'))).toBe(true)

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
}, 240_000)


it.each(['dedicated', 'in-repo'] as const)('finishes installed init for a product using the %s cockpit root', rootChoice => {
    const launcher = join(packedPackageRoot(), 'bin/cockpit.mjs')
    const parent = join(packScratch, `product-${rootChoice}`)
    const product = join(parent, 'store')
    const home = join(parent, 'home')
    mkdirSync(product, { recursive: true })
    mkdirSync(home)
    execFileSync('git', ['init', '--quiet', product])
    const manifest = `${JSON.stringify({ name: 'synthetic-store', version: '0.0.0', scripts: { test: 'node test.mjs' } })}\n`
    writeFileSync(join(product, 'package.json'), manifest)
    const root = rootChoice === 'dedicated' ? `${product}-cockpit` : product
    const answers = join(parent, 'answers.toml')
    writeFileSync(answers, [
        '[cockpit]', `root = "${rootChoice}"`, '',
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
    expect(readFileSync(join(product, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(root, 'cockpit.toml'), 'utf8')).toContain(`dir = "${rootChoice === 'dedicated' ? 'store' : '.'}"`)
    const check = spawnSync(process.execPath, [launcher, 'check', '--config', join(root, 'cockpit.toml'), '--json'],
        { cwd: root, env, encoding: 'utf8' })
    expect(check.status, check.stdout + check.stderr).toBe(0)
}, 180_000)
