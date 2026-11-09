import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeForegroundProcess, executeProbe } from '../environment-exec/execute.js'
import { installedPackageMetadata } from '../package-metadata.js'
import { runUpgrade } from './upgrade-application.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// The registry and package manager are fake executables on PATH, so the real process seam runs.
// The fake `npm` answers `view` with `latest`, and on an install writes the changelog the real
// install would have put in node_modules.
function fixture(latest: string, lockfiles: readonly string[] = ['package-lock.json'], view = `"${latest}"`, installStderr?: string, installStdout?: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-upgrade-')))
    roots.push(root)
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    const project = join(root, 'project')
    for (const dir of [bin, project, join(project, 'node_modules', '@b00dea', 'cockpit')]) mkdirSync(dir, { recursive: true })
    for (const name of lockfiles) writeFileSync(join(project, name), '')
    writeFileSync(join(project, 'cockpit.toml'), '')
    const changelog = `# Changelog\n\n## 9.9.9\n\n- a1: Upgrade: rename the old key.\n- b2: unrelated fix\n\n## ${installedPackageMetadata.version}\n\n- c3: Upgrade: belongs to the old version.\n`
    const script = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`)
        chmodSync(join(bin, name), 0o755)
    }
    // The install also puts the new package's entrypoint in place, which records how it was run.
    const entry = join(project, 'node_modules', '@b00dea', 'cockpit', 'bin', 'cockpit.mjs')
    const entrypoint = `import { appendFileSync } from 'node:fs'\nappendFileSync('${log}', 'cockpit ' + process.argv.slice(2).join(' ') + '\\n')\n`
    const install = `cat > '${join(project, 'node_modules', '@b00dea', 'cockpit', 'CHANGELOG.md')}' <<'EOF'\n${changelog}EOF\nmkdir -p '${join(project, 'node_modules', '@b00dea', 'cockpit', 'bin')}'\ncat > '${entry}' <<'EOF'\n${entrypoint}EOF`
    const failing = installStderr === undefined && installStdout === undefined ? install
        : `${installStdout === undefined ? '' : `cat <<'OUT'\n${installStdout}\nOUT\n`}${installStderr === undefined ? '' : `echo '${installStderr}' >&2\n`}exit 1`
    script('npm', `if [ "$1" = view ]; then cat <<'VIEW'\n${view}\nVIEW\nexit 0; fi\n${failing}`)
    script('pnpm', failing)
    const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    const run = (options: { version?: string; dryRun?: boolean; registryLatest?: string } = {}) => runUpgrade({
        configPath: join(project, 'cockpit.toml'), dryRun: options.dryRun === true,
        ...(options.version === undefined ? {} : { version: options.version }), env: { PATH: `${bin}:/usr/bin:/bin` },
    }, { execute: executeProbe, executeForeground: executeForegroundProcess, releaseTransport: () => async () => options.registryLatest === undefined
        ? { status: 503, body: (async function* () {})() }
        : { status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ name: '@b00dea/cockpit', version: options.registryLatest })) })() } })
    return { project, calls, run }
}

describe('cockpit upgrade', () => {
    it('installs the latest published version exactly, syncs in a new process and reports the Upgrade: lines', async () => {
        const f = fixture('9.9.9')
        const outcome = await f.run()
        expect(outcome.status).toBe(0)
        expect(f.calls()).toEqual([
            'npm view @b00dea/cockpit version --json',
            'npm install --save-dev --save-exact @b00dea/cockpit@9.9.9',
            // The newly installed entrypoint, which the guard can prove, not a package-manager shim.
            `cockpit sync --config ${f.project}/cockpit.toml`,
        ])
        expect(outcome.result).toMatchObject({ sync: `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${f.project}/cockpit.toml` })
        expect(outcome.result).toMatchObject({ from: installedPackageMetadata.version, to: '9.9.9', packageManager: 'npm',
            upgradeSteps: ['a1: Upgrade: rename the old key.'], next: expect.stringContaining('git diff') })
    })

    it('uses the package manager the lockfile names and prints, without running, on --dry-run', async () => {
        const f = fixture('9.9.9', ['pnpm-lock.yaml'])
        const outcome = await f.run({ version: '9.9.9', dryRun: true })
        expect(f.calls()).toEqual([])
        expect(outcome.result).toMatchObject({ install: 'pnpm add --save-dev --save-exact @b00dea/cockpit@9.9.9', dryRun: true })
        await f.run({ version: '9.9.9' })
        expect(f.calls()[0]).toBe('pnpm add --save-dev --save-exact @b00dea/cockpit@9.9.9')
    })

    // An agent asked to upgrade an install that is already current has finished, not failed.
    it('succeeds without running anything when already current or when the latest is older', async () => {
        const current = fixture(installedPackageMetadata.version)
        const latest = await current.run()
        expect(latest).toMatchObject({ status: 0, result: { from: installedPackageMetadata.version, to: installedPackageMetadata.version } })
        expect(latest.diagnostics).toEqual([expect.objectContaining({ severity: 'info', code: 'UPGRADE_ALREADY_CURRENT', message: expect.stringContaining(`already on ${installedPackageMetadata.version}`) })])
        expect(await current.run({ version: installedPackageMetadata.version })).toMatchObject({ status: 0, diagnostics: [{ severity: 'info', code: 'UPGRADE_ALREADY_CURRENT' }] })
        expect(current.calls().filter(call => !call.startsWith('npm view'))).toEqual([])
        // An unreleased or prerelease install sits above the registry's latest; that is not a fault.
        const ahead = fixture('0.0.1')
        expect(await ahead.run()).toMatchObject({ status: 0, diagnostics: [{ severity: 'info', code: 'UPGRADE_ALREADY_CURRENT',
            message: `installed ${installedPackageMetadata.version} is newer than the latest published 0.0.1` }] })
    })

    // A wrapper around npm (such as a supply-chain scanner) may print notices beside the answer.
    it('reads the latest version past notices on the lookup output, and shows an unusable answer', async () => {
        const noisy = fixture('9.9.9', ['package-lock.json'], 'notice: some versions were suppressed\n"9.9.9"\nnotice: see the scanner documentation')
        expect(await noisy.run({ dryRun: true })).toMatchObject({ status: 0, result: { to: '9.9.9' } })
        const listed = fixture('9.9.9', ['package-lock.json'], '["9.9.9"]')
        expect(await listed.run({ dryRun: true })).toMatchObject({ status: 0, result: { to: '9.9.9' } })
        // npm prints a list of several versions one per line; no line of it is the answer.
        const several = fixture('9.9.9', ['package-lock.json'], '[\n  "1.0.0",\n  "1.0.1"\n]')
        expect((await several.run({ dryRun: true })).diagnostics).toEqual([expect.objectContaining({ code: 'UPGRADE_REGISTRY_UNREACHABLE' })])
        const unusable = fixture('9.9.9', ['package-lock.json'], 'notice: nothing to see\n["1.0.0", "1.0.1"]')
        expect((await unusable.run({ dryRun: true })).diagnostics).toEqual([expect.objectContaining({ code: 'UPGRADE_REGISTRY_UNREACHABLE',
            message: expect.stringContaining('["1.0.0", "1.0.1"]') })])
    })

    it('refuses a missing or ambiguous lockfile before running anything', async () => {
        for (const lockfiles of [[], ['package-lock.json', 'yarn.lock'], ['bun.lock']]) {
            const f = fixture('9.9.9', lockfiles)
            const outcome = await f.run()
            expect(outcome.diagnostics[0]).toMatchObject({ code: 'UPGRADE_PACKAGE_MANAGER_UNKNOWN', fix: expect.any(String) })
            expect(f.calls()).toEqual([])
        }
    })

    // A package-age filter in the package manager hides new releases and prints a notice beside an older
    // version; reporting that as "already current" would tell the person a stale install is fine.
    it('refuses a latest lookup that a package-age filter answered, names the real latest and the exact-version command', async () => {
        const notice = 'Safe-chain: Some package versions were suppressed during package metadata resolution due to minimum package age.\n  To disable this check, use: --flag'
        const filtered = fixture('9.9.9', ['package-lock.json'], `${notice}\n["0.0.1"]`)
        const outcome = await filtered.run({ registryLatest: '9.9.9' })
        expect(outcome.status).toBe(2)
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UPGRADE_LATEST_FILTERED',
            message: expect.stringContaining('upgrade 9.9.9 --config <your cockpit.toml>'),
            fix: expect.stringContaining('upgrade <version> --config <your cockpit.toml>') })])
        expect(JSON.stringify(outcome.diagnostics)).not.toMatch(/skip|disable/i)
        expect(filtered.calls().filter(call => !call.startsWith('npm view'))).toEqual([])
        const unread = fixture('9.9.9', ['package-lock.json'], `${notice}\n["0.0.1"]`)
        expect((await unread.run()).diagnostics).toEqual([expect.objectContaining({ code: 'UPGRADE_LATEST_FILTERED',
            message: expect.stringContaining('could not be read') })])
        // A failed install that carries the same notice says so, instead of only quoting its tail.
        const refusedInstall = fixture('9.9.9', ['package-lock.json'], '"9.9.9"', 'blocked by minimum package age')
        expect((await refusedInstall.run()).diagnostics).toEqual([expect.objectContaining({ code: 'UPGRADE_INSTALL_FAILED',
            message: expect.stringContaining('package-age filter') })])
    })

    // Under a wrapped pnpm the 404 and the age notice go to stdout, after a runtime deprecation warning on
    // stderr; quoting only the stderr tail named the warning and hid the cause.
    it('quotes the lines that explain a failed install from both streams, not runtime noise, and offers no bypass', async () => {
        const stdout = [
            ' ERR_PNPM_FETCH_404  GET https://registry.example/@b00dea%2Fcockpit: Not Found - 404',
            'Safe-chain: Some package versions were suppressed during package metadata resolution due to minimum package age.',
            '  To disable this check, use: --safe-chain-skip-minimum-package-age',
        ].join('\n')
        const stderr = '(node:95139) [DEP0169] DeprecationWarning: url.parse() behavior is not standardized\n(Use node --trace-deprecation ... to show where the warning was created)'
        const f = fixture('9.9.9', ['pnpm-lock.yaml'], '"9.9.9"', stderr, stdout)
        const [diagnostic] = (await f.run({ version: '9.9.9' })).diagnostics
        expect(diagnostic).toMatchObject({ code: 'UPGRADE_INSTALL_FAILED' })
        expect(diagnostic!.message).toContain('ERR_PNPM_FETCH_404')
        expect(diagnostic!.message).toContain('package-age filter')
        expect(diagnostic!.message).toMatch(/wait|exempt/)
        expect(diagnostic!.message).not.toMatch(/DEP0169|trace-deprecation|skip|disable/i)
        expect(diagnostic!.fix).not.toMatch(/skip|disable/i)
    })
})
