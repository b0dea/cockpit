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
function fixture(latest: string, lockfiles: readonly string[] = ['package-lock.json'], view = `"${latest}"`) {
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
    const install = `cat > '${join(project, 'node_modules', '@b00dea', 'cockpit', 'CHANGELOG.md')}' <<'EOF'\n${changelog}EOF`
    script('npm', `if [ "$1" = view ]; then cat <<'VIEW'\n${view}\nVIEW\nexit 0; fi\n${install}`)
    script('pnpm', install)
    script('npx', 'echo synced')
    const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    const run = (options: { version?: string; dryRun?: boolean } = {}) => runUpgrade({
        configPath: join(project, 'cockpit.toml'), dryRun: options.dryRun === true,
        ...(options.version === undefined ? {} : { version: options.version }), env: { PATH: `${bin}:/usr/bin:/bin` },
    }, { execute: executeProbe, executeForeground: executeForegroundProcess })
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
            `npx --no cockpit sync --config ${f.project}/cockpit.toml`,
        ])
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
    })

    // A wrapper around npm (such as a supply-chain scanner) may print notices beside the answer.
    it('reads the latest version past notices on the lookup output, and shows an unusable answer', async () => {
        const noisy = fixture('9.9.9', ['package-lock.json'], 'notice: some versions were suppressed\n"9.9.9"\nnotice: see the scanner documentation')
        expect(await noisy.run({ dryRun: true })).toMatchObject({ status: 0, result: { to: '9.9.9' } })
        const listed = fixture('9.9.9', ['package-lock.json'], '["9.9.9"]')
        expect(await listed.run({ dryRun: true })).toMatchObject({ status: 0, result: { to: '9.9.9' } })
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
})
