import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    expectedPackageFiles, generateSbom, runSupplyChainCheck,
} from '../../../scripts/supply-chain-check.mjs'
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
const detector = join(repositoryRoot, 'scripts/supply-chain-check.mjs')
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
        'package.json', 'package-lock.json', '.github/workflows/ci.yml', '.github/workflows/external-links.yml',
        '.github/workflows/release.yml', '.github/workflows/dependabot-automerge.yml', '.github/dependabot.yml',
    ]) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        cpSync(join(repositoryRoot, path), join(root, path))
    }
    cpSync(join(repositoryRoot, 'packages/cockpit'), join(root, 'packages/cockpit'), { recursive: true })
    cpSync(join(repositoryRoot, '.github/actions'), join(root, '.github/actions'), { recursive: true })
    cpSync(join(repositoryRoot, '.github/scripts'), join(root, '.github/scripts'), { recursive: true })
    return root
}

function writeWorkflow(root: string, name: string, body: string) {
    writeFileSync(join(root, `.github/workflows/${name}.yml`), body)
}

function writeCompositeAction(root: string, name: string, body: string) {
    const path = join(root, `.github/actions/${name}/action.yml`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
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
            'pack', '--json', '--dry-run', '--workspace', '@b0dea/cockpit',
        ], expect.objectContaining({ cwd: repositoryRoot }))
        expect(childProcess.execFileSync).toHaveBeenNthCalledWith(2, 'npm', [
            'sbom', '--workspace', '@b0dea/cockpit', '--sbom-format', 'cyclonedx', '--package-lock-only',
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

    it('admits the shipped release-evidence helper and refuses an inventory that omits it', () => {
        expect(PACK_FILES).toContain('libexec/release-evidence.mjs')
        expect(inspect(repositoryRoot, PACK_FILES.filter(path => path !== 'libexec/release-evidence.mjs')).diagnostics)
            .toContainEqual(expect.objectContaining({ code: 'PACKAGE_REQUIRED_FILE_MISSING', path: 'libexec/release-evidence.mjs' }))
    })

    it.each([
        ['mutable dependency', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.dependencies.zod = '^4.4.3' }), PACK_FILES, 'DEPENDENCY_VERSION_MUTABLE'],
        ['lock mismatch', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['packages/cockpit'].dependencies.zod = '4.4.2' }), PACK_FILES, 'LOCKFILE_MISMATCH'],
        ['lock-only direct dependency', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['packages/cockpit'].dependencies.extra = '1.0.0' }), PACK_FILES, 'LOCKFILE_MISMATCH'],
        ['new transitive installer', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['node_modules/synthetic-installer'] = { version: '1.0.0', hasInstallScript: true } }), PACK_FILES, 'LOCK_EXECUTABLE_POLICY_CHANGED'],
        ['new transitive binary', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['node_modules/synthetic-binary'] = { version: '1.0.0', bin: { synthetic: 'bin/synthetic.js' } } }), PACK_FILES, 'LOCK_EXECUTABLE_POLICY_CHANGED'],
        ['changed transitive binary', (root: string) => mutate(root, 'package-lock.json', value => { value.packages['node_modules/yaml'].bin.yaml = 'bin/changed.mjs' }), PACK_FILES, 'LOCK_EXECUTABLE_POLICY_CHANGED'],
        ['allowScripts mismatch', (root: string) => mutate(root, 'package.json', value => { delete value.allowScripts['esbuild@0.28.2'] }), PACK_FILES, 'ALLOW_SCRIPTS_POLICY_MISMATCH'],
        ['install script', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.scripts.postinstall = 'node install.mjs' }), PACK_FILES, 'INSTALL_SCRIPT_PRESENT'],
        ['binary', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.bin.extra = 'bin/extra.mjs' }), PACK_FILES, 'PACKAGE_BIN_CHANGED'],
        ['source link', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.repository.url = 'https://example.invalid/source.git' }), PACK_FILES, 'PACKAGE_LINKS_CHANGED'],
        ['type target', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.types = './dist/missing.d.ts' }), PACK_FILES, 'PACKAGE_EXPORTS_CHANGED'],
        ['runtime dependency', (root: string) => mutate(root, 'packages/cockpit/package.json', value => { value.dependencies.extra = '1.0.0' }), PACK_FILES, 'RUNTIME_DEPENDENCIES_CHANGED'],
        ['mutable action', (root: string) => writeFileSync(join(root, '.github/workflows/ci.yml'), readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/actions\/checkout@[a-f0-9]{40}/, 'actions/checkout@v7')), PACK_FILES, 'WORKFLOW_ACTION_MUTABLE'],
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
            ['a publish job that never stamps the source revision', '.github/scripts/release-publish.sh', (text: string) => text.replaceAll('cockpitSourceRevision', 'sourceRevisionRemoved'), 'RELEASE_STAMP_MISSING'],
            ['a publish job without provenance', '.github/workflows/release.yml', (text: string) => text.replace("NPM_CONFIG_PROVENANCE: 'true'", "NPM_CONFIG_PROVENANCE: 'false'"), 'RELEASE_PROVENANCE_MISSING'],
            ['a publish job without the OIDC token scope', '.github/workflows/release.yml', (text: string) => text.replace(/ +id-token: write[^\n]*\n/, ''), 'RELEASE_PROVENANCE_MISSING'],
            ['a release workflow with no publish job', '.github/workflows/release.yml', (text: string) => text.replace('  publish:\n', '  other:\n'), 'RELEASE_JOB_MISSING'],
            ['a publish script under an input the publish action ignores', '.github/workflows/release.yml',
                (text: string) => text.replace('script: bash .github/scripts/release-publish.sh', 'publish-script: bash .github/scripts/release-publish.sh'), 'RELEASE_STAMP_MISSING'],
            ['a publish job outside the npm deployment environment', '.github/workflows/release.yml',
                (text: string) => text.replace('    environment: npm\n', ''), 'RELEASE_ENVIRONMENT_MISSING'],
            ['a publish job that never attaches authenticated release evidence', '.github/workflows/release.yml',
                (text: string) => text.replace('gh release upload "$tag" release-evidence.json release-evidence.json.sha256', 'echo evidence-not-uploaded'),
                'RELEASE_EVIDENCE_MISSING'],
            ['release evidence before a confirmed publication', '.github/workflows/release.yml',
                (text: string) => text.replace("if: steps.changesets.outputs.published == 'true'", 'if: always()'),
                'RELEASE_EVIDENCE_MISSING'],
            ['release evidence from a legacy missing action output', '.github/workflows/release.yml',
                (text: string) => text.replace('outputs.published-packages', 'outputs.publishedPackages'),
                'RELEASE_EVIDENCE_MISSING'],
            ['release evidence for an unverified package set', '.github/workflows/release.yml',
                (text: string) => text.replace('published.length !== 1', 'published.length < 1'),
                'RELEASE_EVIDENCE_MISSING'],
            ['release evidence without registry integrity', '.github/workflows/release.yml',
                (text: string) => text.replace('dist.integrity --json', 'dist.tarball --json'),
                'RELEASE_EVIDENCE_MISSING'],
            ['release evidence without exact tag readback', '.github/workflows/release.yml',
                (text: string) => text.replace('gh release view "$tag"', 'gh release view --latest'),
                'RELEASE_EVIDENCE_MISSING'],
            ['an update entry without a cooldown', '.github/dependabot.yml', (text: string) => text.replace('    cooldown:\n      default-days: 7\n', ''), 'DEPENDABOT_COOLDOWN_MISSING'],
            ['a cooldown shorter than seven days', '.github/dependabot.yml', (text: string) => text.replace('default-days: 7', 'default-days: 6'), 'DEPENDABOT_COOLDOWN_MISSING'],
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

    it('checks reusable workflow jobs and every external edge inside local composite actions', () => {
        const root = fixture()
        writeWorkflow(root, 'borrowed', [
            'name: Borrowed',
            'on: push',
            'permissions:',
            '  contents: read',
            'jobs:',
            '  borrowed:',
            '    uses: owner/repository/.github/workflows/check.yml@main',
            '',
        ].join('\n'))
        writeCompositeAction(root, 'nested', [
            'name: Nested',
            'description: Synthetic nested dependency',
            'runs:',
            '  using: composite',
            '  steps:',
            '    - uses: owner/action@main',
            '      shell: bash',
            '',
        ].join('\n'))
        writeWorkflow(root, 'nested', [
            'name: Nested',
            'on: push',
            'permissions:',
            '  contents: read',
            'jobs:',
            '  nested:',
            '    runs-on: ubuntu-latest',
            '    steps:',
            '      - uses: ./.github/actions/nested',
            '',
        ].join('\n'))

        const mutable = inspect(root, PACK_FILES).diagnostics.filter(row => row.code === 'WORKFLOW_ACTION_MUTABLE')
        expect(mutable.map(row => row.message)).toEqual(expect.arrayContaining([
            expect.stringContaining('owner/repository/.github/workflows/check.yml@main'),
            expect.stringContaining('owner/action@main'),
        ]))
    })

    it('confines local actions and refuses cyclic local action graphs', () => {
        const root = fixture()
        writeCompositeAction(root, 'first', [
            'name: First', 'description: Synthetic cycle', 'runs:', '  using: composite', '  steps:',
            '    - uses: ./.github/actions/second', '',
        ].join('\n'))
        writeCompositeAction(root, 'second', [
            'name: Second', 'description: Synthetic cycle', 'runs:', '  using: composite', '  steps:',
            '    - uses: ./.github/actions/first', '',
        ].join('\n'))
        writeWorkflow(root, 'local', [
            'name: Local', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  local:',
            '    runs-on: ubuntu-latest', '    steps:', '      - uses: ./.github/actions/first',
            '      - uses: ./.github/actions/../workflows', '',
        ].join('\n'))

        expect(inspect(root, PACK_FILES).diagnostics.map(row => row.code)).toEqual(expect.arrayContaining([
            'WORKFLOW_ACTION_CYCLE',
            'WORKFLOW_ACTION_LOCAL_INVALID',
        ]))
    })

    it('refuses linked workflow and action paths before following their targets', () => {
        const actionRoot = fixture()
        const borrowedActions = join(actionRoot, '.borrowed-actions')
        rmSync(join(actionRoot, '.github/actions'), { recursive: true })
        mkdirSync(borrowedActions)
        symlinkSync('../.borrowed-actions', join(actionRoot, '.github/actions'))
        writeCompositeAction(actionRoot, 'linked-base', [
            'name: Linked', 'description: Outside the owned action directory', 'runs:', '  using: composite', '  steps: []', '',
        ].join('\n'))
        writeWorkflow(actionRoot, 'linked-action', [
            'name: Linked action', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  linked:',
            '    runs-on: ubuntu-latest', '    steps:', '      - uses: ./.github/actions/linked-base', '',
        ].join('\n'))

        const workflowRoot = fixture()
        const borrowedWorkflow = join(workflowRoot, '.borrowed-workflow.yml')
        writeFileSync(borrowedWorkflow, [
            'name: Borrowed', 'on: push', 'permissions:', '  contents: read', 'jobs: {}', '',
        ].join('\n'))
        symlinkSync('../../.borrowed-workflow.yml', join(workflowRoot, '.github/workflows/linked.yml'))

        expect(inspect(actionRoot, PACK_FILES).diagnostics.map(row => row.code)).toContain('WORKFLOW_ACTION_LOCAL_INVALID')
        expect(inspect(workflowRoot, PACK_FILES).diagnostics.map(row => row.code)).toContain('WORKFLOW_ACTION_LOCAL_INVALID')
    })

    it('accepts a contained acyclic local action whose external edges are immutable', () => {
        const root = fixture()
        writeCompositeAction(root, 'pinned', [
            'name: Pinned', 'description: Synthetic pinned dependency', 'runs:', '  using: composite', '  steps:',
            '    - uses: owner/action@0123456789abcdef0123456789abcdef01234567', '',
        ].join('\n'))
        writeWorkflow(root, 'local', [
            'name: Local', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  local:',
            '    runs-on: ubuntu-latest', '    steps:', '      - uses: ./.github/actions/pinned', '',
        ].join('\n'))

        expect(inspect(root, PACK_FILES).diagnostics.filter(row => row.code.startsWith('WORKFLOW_ACTION'))).toEqual([])
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
        [{ '@b0dea/cockpit': artifact }, true],
        [{ first: artifact, second: artifact }, false],
        [{ '@b0dea/cockpit': { files: [{ path: null }] } }, false],
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
    writeFileSync(manifest, `${JSON.stringify({ name: '@b0dea/cockpit', version: '0.1.0', cockpitSourceRevision: 'development' }, null, 2)}\n`)
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
    expect(absent.stderr).toContain('@b0dea/cockpit does not exist on npm yet')
    expect(absent.stderr).toContain('docs/contributing/releasing.md')
    const unreachable = run('unreachable')
    expect(unreachable.status).toBe(1)
    expect(unreachable.stderr).toContain('could not read @b0dea/cockpit from the npm registry')
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
    const manifest = (version: string, extra: object = {}) => json({ name: '@b0dea/cockpit', version, ...extra })
    const lock = (version: string, integrity = 'sha512-synthetic') => json({
        name: 'synthetic-workspace', lockfileVersion: 3,
        packages: { '': { name: 'synthetic-workspace' }, 'packages/cockpit': { name: '@b0dea/cockpit', version }, 'node_modules/zod': { version: '4.4.3', integrity } },
    })
    git('init', '-q', '-b', 'main')
    write('packages/cockpit/package.json', manifest('0.1.0'))
    write('package-lock.json', lock('0.1.0'))
    write('packages/cockpit/CHANGELOG.md', '# @b0dea/cockpit\n')
    write('.changeset/README.md', 'readme\n')
    write('.changeset/config.json', '{}\n')
    write('.changeset/brave-fox.md', '---\n"@b0dea/cockpit": minor\n---\n\nA change.\n')
    write('src.ts', 'export {}\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    const bump = () => {
        write('packages/cockpit/package.json', manifest('0.2.0'))
        write('package-lock.json', lock('0.2.0'))
        write('packages/cockpit/CHANGELOG.md', '# @b0dea/cockpit\n\n## 0.2.0\n\n- A change.\n')
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
