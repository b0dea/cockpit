import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    expectedPackageFiles, generateSbom, refreshedPins, runSupplyChainCheck,
} from '../../../scripts/supply-chain-check.ts'
import { cockpitPackageVersion } from './test-support/package-version.js'

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    execFileSync: childProcess.execFileSync,
}))

interface SupplyChainResult {
    readonly diagnostics: readonly Readonly<{ code: string; path: string; message: string }>[]
    readonly operatorGaps: readonly string[]
}
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const detector = join(repositoryRoot, 'scripts/supply-chain-check.ts')
const scratch: string[] = []
const PACK_FILES = expectedPackageFiles(repositoryRoot)

afterEach(() => {
    scratch.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
    childProcess.execFileSync.mockReset()
})

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-supply-chain-'))
    scratch.push(root)
    for (const path of [
        'package.json', 'package-lock.json', '.npmrc', '.github/workflows/ci.yml', '.github/workflows/external-links.yml',
        '.github/workflows/release.yml', '.github/workflows/dependabot-automerge.yml', '.github/dependabot.yml',
    ]) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        cpSync(join(repositoryRoot, path), join(root, path))
    }
    cpSync(join(repositoryRoot, 'packages/cockpit'), join(root, 'packages/cockpit'), { recursive: true })
    cpSync(join(repositoryRoot, 'docs'), join(root, 'docs'), { recursive: true })
    cpSync(join(repositoryRoot, '.github/actions'), join(root, '.github/actions'), { recursive: true })
    cpSync(join(repositoryRoot, '.github/scripts'), join(root, '.github/scripts'), { recursive: true })
    return root
}

function writeWorkflow(root: string, name: string, body: string) {
    writeFileSync(join(root, `.github/workflows/${name}.yml`), body)
}

function mutate(root: string, path: string, update: (value: any) => void) {
    const absolute = join(root, path)
    const value = JSON.parse(readFileSync(absolute, 'utf8'))
    update(value)
    writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
}

function inspect(root: string, packFiles: readonly string[]): SupplyChainResult {
    const result = spawnSync(process.execPath, [detector, '--inspect', root, JSON.stringify(packFiles)], { encoding: 'utf8' })
    expect([0, 1]).toContain(result.status)
    expect(result.stderr).toBe('')
    return JSON.parse(result.stdout) as SupplyChainResult
}

describe('the supply-chain readiness detector', () => {
    it('runs npm pack and npm sbom for the package workspace', () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-sbom-output-')))
        scratch.push(root)
        childProcess.execFileSync
            .mockReturnValueOnce(JSON.stringify([{ filename: 'synthetic.tgz', files: PACK_FILES.map(path => ({ path })) }]))
            .mockReturnValueOnce('{"bomFormat":"CycloneDX"}\n')
        const output = join(root, 'output', 'sbom.json')

        expect(runSupplyChainCheck(repositoryRoot)).toBe(0)
        generateSbom(repositoryRoot, output)

        expect(childProcess.execFileSync).toHaveBeenNthCalledWith(1, 'npm', [
            'pack', '--json', '--dry-run', '--workspace', '@b00dea/cockpit',
        ], expect.objectContaining({ cwd: repositoryRoot }))
        expect(childProcess.execFileSync).toHaveBeenNthCalledWith(2, 'npm', [
            'sbom', '--workspace', '@b00dea/cockpit', '--sbom-format', 'cyclonedx', '--package-lock-only',
        ], expect.objectContaining({ cwd: expect.stringContaining('cockpit-sbom-input-') }))
        expect(readFileSync(output, 'utf8')).toBe('{"bomFormat":"CycloneDX"}\n')
    })

    it('installs CI dependencies without executing lifecycle scripts', () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-install-policy-'))
        scratch.push(root)
        const manifest = { name: 'synthetic-install', version: '1.0.0', scripts: {
            preinstall: `node -e "require('node:fs').writeFileSync('installer-ran', 'synthetic')"`,
        } }
        writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
        writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
            name: manifest.name, version: manifest.version, lockfileVersion: 3,
            packages: { '': { ...manifest, hasInstallScript: true } },
        }))
        const env = { ...process.env, NPM_CONFIG_CACHE: join(root, 'cache') }
        const install = (args: string[]) => spawnSync('npm', [...args, '--offline', '--no-audit', '--no-fund'], {
            cwd: root, env, encoding: 'utf8', timeout: 10_000,
        })
        const control = install(['ci'])
        expect(control.status, control.stderr).toBe(0)
        expect(existsSync(join(root, 'installer-ran'))).toBe(true)
        rmSync(join(root, 'installer-ran'))
        const commands = new Set(['ci.yml', 'external-links.yml'].flatMap(path =>
            [...readFileSync(join(repositoryRoot, '.github/workflows', path), 'utf8').matchAll(/^\s*- run: (npm ci[^\n]*)$/gm)]
                .map(match => match[1]!.trim())))
        expect(commands.size).toBeGreaterThan(0)
        for (const command of commands) {
            const result = install(command.split(/\s+/).slice(1))
            expect(result.status, result.stderr).toBe(0)
            expect(existsSync(join(root, 'installer-ran')), command).toBe(false)
        }
    })

    it('accepts exact local inputs and keeps every external publication gate held', () => {
        const result = inspect(repositoryRoot, PACK_FILES)
        expect(result.diagnostics).toEqual([])
        expect(result.operatorGaps).toEqual([
            'package-scope-owner', 'trusted-publisher', 'superseded-minor-deprecation',
        ])
    })

    it('accepts a release version bump recorded in both manifest and lockfile and refuses a stale lockfile', () => {
        const root = fixture()
        const [major, minor] = cockpitPackageVersion.split('.').map(Number)
        const bumped = `${major}.${minor + 1}.0`
        mutate(root, 'packages/cockpit/package.json', value => { value.version = bumped })
        expect(inspect(root, PACK_FILES).diagnostics.map(row => row.code)).toContain('LOCK_EXECUTABLE_POLICY_CHANGED')
        mutate(root, 'package-lock.json', value => { value.packages['packages/cockpit'].version = bumped })
        expect(inspect(root, PACK_FILES).diagnostics).toEqual([])
    })

    it('refreshes the pins from the lockfile but leaves each install script for a person to approve', () => {
        const current = refreshedPins(repositoryRoot)
        expect(current.text).toBe(readFileSync(join(repositoryRoot, 'scripts/supply-chain-pins.json'), 'utf8'))
        expect(current.pending).toEqual([])

        const root = fixture()
        mutate(root, 'package-lock.json', value => {
            value.packages['node_modules/yaml'].version = '2.99.0'
            value.packages['node_modules/esbuild'].version = '0.99.0'
        })
        const unapproved = refreshedPins(root)
        const rows = (text: string) => JSON.parse(text).executableLockNodes as { path: string; version?: string; allowScript?: true }[]
        expect(rows(unapproved.text)).toContainEqual(expect.objectContaining({ path: 'node_modules/yaml', version: '2.99.0' }))
        expect(rows(unapproved.text).find(row => row.path === 'node_modules/esbuild')).not.toHaveProperty('allowScript')
        expect(unapproved.pending).toEqual([
            expect.stringContaining('esbuild@0.99.0 has an install script that allowScripts in package.json does not approve'),
            expect.stringContaining('approves esbuild@0.28.2, which is not an installer in package-lock.json'),
        ])

        // The command refuses too, not only the function: its exit status is what stops the procedure.
        mkdirSync(join(root, 'scripts'))
        for (const name of ['supply-chain-check.ts', 'supply-chain-pins.json', 'build-cockpit.ts']) {
            cpSync(join(repositoryRoot, 'scripts', name), join(root, 'scripts', name))
        }
        symlinkSync(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'))
        // Real path: the script runs its command line only when argv names its own resolved file.
        const command = spawnSync(process.execPath, [realpathSync(join(root, 'scripts/supply-chain-check.ts')), '--refresh-pins'], { encoding: 'utf8' })
        expect(command.status, command.stderr).toBe(1)
        expect(command.stderr).toContain('ALLOW_SCRIPTS_REVIEW_NEEDED esbuild@0.99.0 has an install script')
        expect(readFileSync(join(root, 'scripts/supply-chain-pins.json'), 'utf8')).toBe(unapproved.text)

        mutate(root, 'package.json', value => {
            delete value.allowScripts['esbuild@0.28.2']
            value.allowScripts.esbuild = true
        })
        expect(refreshedPins(root).pending).toEqual([
            expect.stringContaining('esbuild@0.99.0 has an install script'),
            expect.stringContaining('lists esbuild, but cockpit approves an install script only as an exact "name@version": true entry'),
        ])
        mutate(root, 'package.json', value => {
            delete value.allowScripts.esbuild
            value.allowScripts['esbuild@0.99.0'] = true
        })
        const approved = refreshedPins(root)
        expect(rows(approved.text).find(row => row.path === 'node_modules/esbuild')).toMatchObject({ version: '0.99.0', allowScript: true })
        expect(approved.pending).toEqual([])
    })

    it.each([
        ['mutable dependency', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.dependencies.zod = '^4.4.3' }), PACK_FILES, 'DEPENDENCY_VERSION_MUTABLE'],
        ['lock mismatch', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['packages/cockpit'].dependencies.zod = '4.4.2' }), PACK_FILES, 'LOCKFILE_MISMATCH'],
        ['lock-only direct dependency', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['packages/cockpit'].dependencies.extra = '1.0.0' }), PACK_FILES, 'LOCKFILE_MISMATCH'],
        ['new transitive installer', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['node_modules/synthetic-installer'] = { version: '1.0.0', hasInstallScript: true } }), PACK_FILES, 'LOCK_EXECUTABLE_POLICY_CHANGED'],
        ['installer allowScripts does not approve', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['node_modules/synthetic-installer'] = { version: '1.0.0', hasInstallScript: true } }), PACK_FILES, 'ALLOW_SCRIPTS_APPROVAL_MISSING'],
        ['new transitive binary', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['node_modules/synthetic-binary'] = { version: '1.0.0', bin: { synthetic: 'bin/synthetic.js' } } }), PACK_FILES, 'LOCK_EXECUTABLE_POLICY_CHANGED'],
        ['changed transitive binary', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['node_modules/yaml'].bin.yaml = 'bin/changed.mjs' }), PACK_FILES, 'LOCK_EXECUTABLE_POLICY_CHANGED'],
        ['allowScripts mismatch', (root: string) => mutate(root, 'package.json', value => { delete value.allowScripts['esbuild@0.28.2'] }), PACK_FILES, 'ALLOW_SCRIPTS_POLICY_MISMATCH'],
        ['install script', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.scripts.postinstall = 'node install.mjs' }), PACK_FILES, 'INSTALL_SCRIPT_PRESENT'],
        ['binary', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.bin.extra = 'bin/extra.mjs' }), PACK_FILES, 'PACKAGE_BIN_CHANGED'],
        ['source link', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.repository.url = 'https://example.invalid/source.git' }), PACK_FILES, 'PACKAGE_LINKS_CHANGED'],
        ['type target', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.types = './dist/missing.d.ts' }), PACK_FILES, 'PACKAGE_EXPORTS_CHANGED'],
        ['runtime dependency', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.dependencies.extra = '1.0.0' }), PACK_FILES, 'RUNTIME_DEPENDENCIES_CHANGED'],
        ['broad permissions', (root: string) => writeFileSync(join(root, '.github/workflows/ci.yml'), readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace('permissions:\n      contents: read', 'permissions:\n      contents: write')), PACK_FILES, 'WORKFLOW_PERMISSIONS_BROAD'],
        ['missing invocation', (root: string) => writeFileSync(join(root, '.github/workflows/ci.yml'), readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace('npm run lint:supply-chain', 'npm run typecheck')), PACK_FILES, 'WORKFLOW_LINT_NOT_INVOKED'],
        ['unscanned tarball', (_root: string) => {}, [], 'PACK_METADATA_MISSING'],
        ['audience leak', (_root: string) => {}, [...PACK_FILES, 'src/private.ts'], 'PACKAGE_AUDIENCE_LEAK'],
        ['extra file under an admitted root', (_root: string) => {}, [...PACK_FILES, 'surfaces/private-note.txt'], 'PACKAGE_AUDIENCE_LEAK'],
        ['missing licence', (_root: string) => {}, PACK_FILES.filter(path => path !== 'LICENSE'), 'PACKAGE_REQUIRED_FILE_MISSING'],
        ['missing package readme', (_root: string) => {}, PACK_FILES.filter(path => path !== 'README.md'), 'PACKAGE_REQUIRED_FILE_MISSING'],
    ])('refuses %s', (_name, plant, packFiles, code) => {
        const root = fixture()
        plant(root)
        expect(inspect(root, packFiles).diagnostics.map(row => row.code)).toContain(code)
    })

    describe('release properties are read from the files that implement them', () => {
        const edit = (root: string, path: string, update: (text: string) => string) =>
            writeFileSync(join(root, path), update(readFileSync(join(root, path), 'utf8')))
        const codes = (root: string) => inspect(root, PACK_FILES).diagnostics.map(row => row.code)

        it.each([
            ['a publish job without provenance', '.github/workflows/release.yml', (text: string) => text.replace("NPM_CONFIG_PROVENANCE: 'true'", "NPM_CONFIG_PROVENANCE: 'false'"), 'RELEASE_PROVENANCE_MISSING'],
            ['a publish job without the OIDC token scope', '.github/workflows/release.yml', (text: string) => text.replace(/ +id-token: write[^\n]*\n/, ''), 'RELEASE_PROVENANCE_MISSING'],
            ['a release workflow with no publish job', '.github/workflows/release.yml', (text: string) => text.replace('  publish:\n', '  other:\n'), 'RELEASE_JOB_MISSING'],
            ['a version job that opens a pull request for a private package', '.github/workflows/release.yml', (text: string) => text.replace(" && needs.select-mode.outputs.private == 'false'", ''), 'RELEASE_VERSION_UNGATED'],
            ['a publish job outside the npm deployment environment', '.github/workflows/release.yml',
                (text: string) => text.replace('    environment: npm\n', ''), 'RELEASE_ENVIRONMENT_MISSING'],
            ['an update entry without a cooldown', '.github/dependabot.yml', (text: string) => text.replace('    cooldown:\n      default-days: 7\n', ''), 'DEPENDABOT_COOLDOWN_MISSING'],
            ['a cooldown shorter than seven days', '.github/dependabot.yml', (text: string) => text.replace('default-days: 7', 'default-days: 6'), 'DEPENDABOT_COOLDOWN_MISSING'],
            ['an npm config without a minimum release age', '.npmrc', (text: string) => text.replace('min-release-age=2', ''), 'NPM_RELEASE_AGE_MISSING'],
            ['a later npm config line that lowers the release age', '.npmrc', (text: string) => `${text}min-release-age=1\n`, 'NPM_RELEASE_AGE_MISSING'],
        ])('refuses %s', (_name, path, update, code) => {
            const root = fixture()
            edit(root, path, update)
            expect(codes(root)).toContain(code)
        })
    })

    describe('write scopes and publication are confined to the reviewed workflow jobs', () => {
        const edit = (root: string, name: string, update: (text: string) => string) => {
            const path = join(root, `.github/workflows/${name}.yml`)
            writeFileSync(path, update(readFileSync(path, 'utf8')))
        }
        const codes = (root: string) => inspect(root, PACK_FILES).diagnostics.map(row => row.code)
        const publisher = (steps: string[]) => [
            'name: Other', 'on: push', 'permissions: {}', 'jobs:', '  other:', '    runs-on: ubuntu-latest', '    steps:', ...steps, '',
        ].join('\n')

        it.each([
            ['an extra scope in the publish job', 'release', (text: string) => text.replace('id-token: write ', 'packages: write\n      id-token: write ')],
            ['id-token in the auto-merge job', 'dependabot-automerge', (text: string) => text.replace('pull-requests: write', 'pull-requests: write\n      id-token: write')],
            ['a scope widened past the release jobs', 'ci', (text: string) => text.replace('permissions:\n      contents: read', 'permissions:\n      contents: write')],
            ['the OIDC token in the version job', 'release', (text: string) => text.replace('pull-requests: write', 'pull-requests: write\n      id-token: write')],
            ['the publish grants under another job name', 'release', (text: string) => text.replace('  publish:\n', '  release:\n')],
            ['a write default for the whole workflow', 'release', (text: string) => text.replace('permissions:\n  contents: read', 'permissions:\n  contents: write')],
        ])('refuses %s', (_name, workflow, update) => {
            const root = fixture()
            edit(root, workflow, update)
            expect(codes(root)).toContain('WORKFLOW_PERMISSIONS_BROAD')
        })

        it('refuses a publish command in any workflow but the publish job', () => {
            const root = fixture()
            writeWorkflow(root, 'other', publisher(['      - run: npm publish --provenance']))
            expect(codes(root)).toContain('PUBLICATION_PATH_PRESENT')
        })

        it('refuses a publish command hidden in a script that another workflow runs', () => {
            const root = fixture()
            mkdirSync(join(root, '.github/scripts'), { recursive: true })
            writeFileSync(join(root, '.github/scripts/ship.sh'), '#!/usr/bin/env bash\nnpx changeset publish\n')
            writeWorkflow(root, 'other', publisher(['      - run: bash .github/scripts/ship.sh']))
            expect(codes(root)).toContain('PUBLICATION_PATH_PRESENT')
        })

        it.each([
            ['the combined action publish input', [
                '      - uses: changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51',
                '        with:',
                '          publish-script: node ship.mjs',
            ]],
            ['the publish action, which publishes without any script', [
                '      - uses: changesets/action/publish@ae32849d5ba541f9ae29e40e22a623bc13562f51',
            ]],
        ])('refuses %s outside the publish job', (_name, steps) => {
            const root = fixture()
            writeWorkflow(root, 'other', publisher(steps))
            expect(codes(root)).toContain('PUBLICATION_PATH_PRESENT')
        })

        it('refuses a missing or escaping script path instead of skipping it', () => {
            const root = fixture()
            writeWorkflow(root, 'other', publisher(['      - run: bash .github/scripts/absent.sh']))
            expect(codes(root)).toContain('WORKFLOW_SCRIPT_INVALID')
        })
    })

    it('names where a malformed workflow or release file stopped parsing without quoting it', () => {
        const root = fixture()
        const broken = 'name: [CANARY_SECRET_7f3a\nkey: value\n'
        writeWorkflow(root, 'broken', broken)
        writeFileSync(join(root, '.github/workflows/release.yml'), broken)

        const diagnostics = inspect(root, PACK_FILES).diagnostics
        const named = (code: string) => diagnostics.find(row => row.code === code && /parse/.test(row.message))
        expect(named('WORKFLOW_INVALID')).toMatchObject({ path: '.github/workflows/broken.yml', message: expect.stringMatching(/at line \d+, column \d+/) })
        expect(named('RELEASE_CONFIG_UNREADABLE')).toMatchObject({ path: '.github/workflows/release.yml', message: expect.stringMatching(/at line \d+, column \d+/) })
        expect(JSON.stringify(diagnostics)).not.toContain('CANARY_SECRET_7f3a')
    })

    it('refuses a linked workflow instead of following it', () => {
        const root = fixture()
        writeFileSync(join(root, '.borrowed-workflow.yml'), [
            'name: Borrowed', 'on: push', 'permissions:', '  contents: write', 'jobs: {}', '',
        ].join('\n'))
        symlinkSync('../../.borrowed-workflow.yml', join(root, '.github/workflows/linked.yml'))
        expect(inspect(root, PACK_FILES).diagnostics).toContainEqual(expect.objectContaining({ code: 'WORKFLOW_INVALID', path: '.github/workflows/linked.yml' }))
    })
})


it('reads both supported npm pack inventories and refuses ambiguous or malformed output', () => {
    const root = fixture()
    const bin = join(root, 'fake-bin')
    mkdirSync(bin)
    const npm = join(bin, 'npm')
    const artifact = { filename: 'synthetic.tgz', files: PACK_FILES.map(path => ({ path })) }
    for (const [output, valid] of [
        [[artifact], true],
        [{ '@b00dea/cockpit': artifact }, true],
        [{ first: artifact, second: artifact }, false],
        [{ '@b00dea/cockpit': { files: [{ path: null }] } }, false],
    ] as const) {
        writeFileSync(npm, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(output))})\n`)
        chmodSync(npm, 0o755)
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
            `import { runSupplyChainCheck } from ${JSON.stringify(pathToFileURL(detector).href)}; process.exitCode = runSupplyChainCheck(process.argv[1]);`, root], {
            encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        })
        if (valid) {
            expect(result.status, result.stderr).toBe(0)
            expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ready' })
        } else {
            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain('[PACK_METADATA_INVALID]')
        }
    }
})

it('stops the release publish before stamping when the package does not exist on npm yet', () => {
    // npm trusted publishing cannot create a package, so the first publication is a manual
    // bootstrap. Without this stop the run would fail later with an authentication error that
    // does not say why.
    const root = mkdtempSync(join(tmpdir(), 'cockpit-release-publish-'))
    scratch.push(root)
    mkdirSync(join(root, 'packages/cockpit'), { recursive: true })
    const manifest = join(root, 'packages/cockpit/package.json')
    writeFileSync(manifest, `${JSON.stringify({ name: '@b00dea/cockpit', version: '0.1.0', cockpitSourceRevision: 'development' }, null, 2)}\n`)
    const bin = join(root, 'fake-bin')
    mkdirSync(bin)
    const published = join(root, 'changeset-publish-ran')
    const run = (registry: 'absent' | 'present' | 'unreachable') => {
        writeFileSync(join(bin, 'npm'), [
            '#!/usr/bin/env bash',
            'if [[ "$1" == --version ]]; then echo 11.6.0; exit 0; fi',
            `if [[ "$1" == view ]]; then case ${registry} in`,
            '  absent) echo "npm error code E404" >&2; exit 1 ;;',
            '  unreachable) echo "npm error code ECONNREFUSED" >&2; exit 1 ;;',
            '  present) echo "$2"; exit 0 ;;',
            'esac; fi',
            'exit 9', '',
        ].join('\n'))
        writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\n[[ "$*" == "changeset publish" ]] && : > ${JSON.stringify(published)}\n`)
        chmodSync(join(bin, 'npm'), 0o755)
        chmodSync(join(bin, 'npx'), 0o755)
        return spawnSync('bash', [join(repositoryRoot, '.github/scripts/release-publish.sh')], {
            cwd: root, encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_SHA: 'a'.repeat(40) },
        })
    }

    const absent = run('absent')
    expect(absent.status).toBe(1)
    expect(absent.stderr).toContain('@b00dea/cockpit does not exist on npm yet')
    expect(absent.stderr).toContain('docs/contributing/releasing.md')
    const unreachable = run('unreachable')
    expect(unreachable.status).toBe(1)
    expect(unreachable.stderr).toContain('could not read @b00dea/cockpit from the npm registry')
    expect(unreachable.stderr).toContain('ECONNREFUSED')
    expect(JSON.parse(readFileSync(manifest, 'utf8')).cockpitSourceRevision).toBe('development')
    expect(existsSync(published)).toBe(false)

    const present = run('present')
    expect(present.status, present.stderr).toBe(0)
    expect(JSON.parse(readFileSync(manifest, 'utf8')).cockpitSourceRevision).toBe('a'.repeat(40))
    expect(existsSync(published)).toBe(true)
})

it('admits only version fields, changelogs and consumed changesets on the Version Packages branch', () => {
    // The release workflow rebuilds the version branch, but anyone who can push to it can add a
    // commit that a reviewer reads as part of the bump.
    const root = mkdtempSync(join(tmpdir(), 'cockpit-version-scope-'))
    scratch.push(root)
    const git = (...args: string[]) => {
        const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
            '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(0)
        return result.stdout.trim()
    }
    const write = (path: string, body: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), body)
    }
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
    const manifest = (version: string, extra: object = {}) => json({ name: '@b00dea/cockpit', version, ...extra })
    const lock = (version: string, integrity = 'sha512-synthetic') => json({
        name: 'synthetic-workspace', lockfileVersion: 3,
        packages: { '': { name: 'synthetic-workspace' }, 'packages/cockpit': { name: '@b00dea/cockpit', version }, 'node_modules/zod': { version: '4.4.3', integrity } },
    })
    git('init', '-q', '-b', 'main')
    write('packages/cockpit/package.json', manifest('0.1.0'))
    write('package-lock.json', lock('0.1.0'))
    write('packages/cockpit/CHANGELOG.md', '# @b00dea/cockpit\n')
    write('.changeset/README.md', 'readme\n')
    write('.changeset/config.json', '{}\n')
    write('.changeset/brave-fox.md', '---\n"@b00dea/cockpit": minor\n---\n\nA change.\n')
    write('src.ts', 'export {}\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    const bump = () => {
        write('packages/cockpit/package.json', manifest('0.2.0'))
        write('package-lock.json', lock('0.2.0'))
        write('packages/cockpit/CHANGELOG.md', '# @b00dea/cockpit\n\n## 0.2.0\n\n- A change.\n')
        rmSync(join(root, '.changeset/brave-fox.md'))
    }
    const check = (edit: () => void, from = base) => {
        git('checkout', '-q', '-f', '-B', 'candidate', base)
        edit()
        git('add', '-A', '.')
        git('commit', '-q', '-m', 'candidate')
        return spawnSync('bash', [join(repositoryRoot, '.github/scripts/check-version-pr-scope.sh'), from, 'HEAD'], { cwd: root, encoding: 'utf8' })
    }

    const clean = check(bump)
    expect(clean.status, clean.stdout + clean.stderr).toBe(0)
    for (const [extra, path] of [
        [() => write('src.ts', 'export const changed = true\n'), 'src.ts'],
        [() => write('packages/cockpit/package.json', manifest('0.2.0', { scripts: { postinstall: 'node install.mjs' } })), 'packages/cockpit/package.json'],
        [() => write('package-lock.json', lock('0.2.0', 'sha512-swapped')), 'package-lock.json'],
        [() => rmSync(join(root, '.changeset/config.json')), '.changeset/config.json'],
        [() => write('.changeset/new-step.md', 'added\n'), '.changeset/new-step.md'],
    ] as const) {
        const refused = check(() => { bump(); extra() })
        expect(refused.status, path).toBe(1)
        expect(refused.stdout).toContain(`::error::${path}: `)
    }
    expect(check(bump, 'f'.repeat(40)).status).not.toBe(0)
})
