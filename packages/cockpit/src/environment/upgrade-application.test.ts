import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeForegroundProcess, executeProbe } from '../environment-exec/execute.js'
import { installedPackageMetadata } from '../package-metadata.js'
import { runUpgrade } from './upgrade-application.js'
import { execFileSync } from 'node:child_process'
import { runCli, type CliIo } from '../cli.js'
import type { Approval } from '../operator-confirmation.js'
import { PENDING_APPROVALS_PATH } from '../pending-approvals.js'
import type { OperatorPolicy } from './operator-application.js'

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

    // An agent may run upgrade unprompted, so it only moves forward: an older cockpit would run its own sync.
    it('refuses to move to an older version, dry run or not, before running anything', async () => {
        const f = fixture('9.9.9')
        for (const dryRun of [false, true]) {
            expect(await f.run({ version: '0.0.1', dryRun })).toMatchObject({ status: 2, diagnostics: [{ severity: 'error', code: 'UPGRADE_VERSION_INVALID',
                message: `0.0.1 is older than the installed ${installedPackageMetadata.version}; upgrade only moves forward` }] })
        }
        expect(f.calls()).toEqual([])
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

const EXEMPTION = 'SAFE_CHAIN_MINIMUM_PACKAGE_AGE_EXCLUSIONS'

// A cockpit root that is a clone with a pushed default branch. The fake `npm` records the age-filter
// exemption each install ran with; the installed entrypoint records the one sync ran with and writes a
// generated file, as a real sync would.
function repository(options: { branch?: string } = {}) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-upgrade-flow-')))
    roots.push(base)
    const bin = join(base, 'bin')
    const log = join(base, 'calls.log')
    const project = join(base, 'project')
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: base }
    const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: project, env, encoding: 'utf8' })
    mkdirSync(bin)
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', join(base, 'origin.git')], { env })
    execFileSync('git', ['clone', '--quiet', join(base, 'origin.git'), project], { env, stdio: 'ignore' })
    git('config', 'user.name', 'Synthetic')
    git('config', 'user.email', 'synthetic@example.invalid')
    writeFileSync(join(project, 'package.json'), `{ "devDependencies": { "@b00dea/cockpit": "${installedPackageMetadata.version}" } }\n`)
    writeFileSync(join(project, 'package-lock.json'), '{}\n')
    writeFileSync(join(project, 'cockpit.toml'), '')
    writeFileSync(join(project, '.gitignore'), 'node_modules/\n.cockpit/local/\n')
    mkdirSync(join(project, '.cockpit'))
    git('add', '--', '.gitignore', 'cockpit.toml', 'package.json', 'package-lock.json')
    git('commit', '--quiet', '-m', 'Create synthetic cockpit')
    git('push', '--quiet', '-u', 'origin', 'main')
    git('remote', 'set-head', 'origin', 'main')
    if (options.branch) {
        git('switch', '--quiet', '-c', options.branch)
        git('push', '--quiet', '-u', 'origin', options.branch)
    }
    const installed = join(project, 'node_modules', '@b00dea', 'cockpit')
    const entrypoint = `import { appendFileSync, writeFileSync } from 'node:fs'\nappendFileSync('${log}', 'cockpit ' + process.argv.slice(2).join(' ') + ' exempt=' + (process.env.${EXEMPTION} ?? '') + '\\n')\nwriteFileSync('AGENTS.md', 'generated\\n')\n`
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm $* exempt=$${EXEMPTION}" >> '${log}'\n`
        + `if [ "$1" = view ]; then echo '"9.9.9"'; exit 0; fi\n`
        + `echo '{ "devDependencies": { "@b00dea/cockpit": "9.9.9" } }' > package.json\necho '{ "upgraded": true }' > package-lock.json\n`
        + `mkdir -p '${join(installed, 'bin')}'\ncat > '${join(installed, 'bin', 'cockpit.mjs')}' <<'EOF'\n${entrypoint}EOF\nprintf '# Changelog\\n' > '${join(installed, 'CHANGELOG.md')}'\n`)
    chmodSync(join(bin, 'npm'), 0o755)
    const config = join(project, 'cockpit.toml')
    const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    const pendingPath = join(project, PENDING_APPROVALS_PATH)
    const pending = () => existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, 'utf8')).items as { argv: string[] }[] : []
    const loadPolicy = async (): Promise<OperatorPolicy> => ({ configSha256: 'a'.repeat(64), widened: [], unrecorded: false, seeded: false, approveMcp: async () => 'a'.repeat(64) })
    // One run of the CLI in the given environment, with what it printed.
    const cli = async (args: readonly string[], runEnv: Record<string, string> = env, io: Partial<CliIo> = {}) => {
        let stdout = '', stderr = ''
        const status = await runCli(args, { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) }, ...io },
            { loadPolicy }, { env: runEnv })
        return { status, stdout, stderr, json: () => JSON.parse(stdout) }
    }
    return { project, config, env, git, calls, pending, cli }
}

describe('cockpit upgrade for an agent and a person', () => {
    // Installing a release a package-age filter calls too new is a person's decision, so an agent's run
    // records the exact release for approve, which exempts cockpit for that one install and nothing else.
    it('queues an agent\'s upgrade for approve, which installs with the age exemption on that child only and commits what it wrote', async () => {
        const f = repository()
        const agent = await f.cli(['upgrade', '--commit', '--config', f.config, '--json'], { ...f.env, CLAUDECODE: '1' })
        expect(agent.status).toBe(2)
        const envelope = agent.json()
        expect(envelope.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'UPGRADE_PERSON_REQUIRED',
            message: expect.stringContaining(`from ${installedPackageMetadata.version} to 9.9.9`) })])
        expect(envelope.guidance[0].text).toBe(`run \`npx --no cockpit approve\` in ${f.project}, in a terminal outside the agent`)
        // On the default branch the branch to commit on comes first, before the person's step.
        expect(envelope.result.next.split('\n')).toEqual(['start a branch first: git switch -c cockpit-9.9.9 origin/main',
            `run \`npx --no cockpit approve\` in ${f.project}, in a terminal outside the agent`])
        expect(f.calls()).toEqual(['npm view @b00dea/cockpit version --json exempt='])
        // The record names the release the agent resolved, so a later publish is not what the person approves.
        expect(f.pending()).toEqual([expect.objectContaining({ argv: ['upgrade', '9.9.9', '--commit', '--config', f.config] })])

        writeFileSync(join(f.project, 'notes.md'), 'unrelated\n')
        const shown: Approval[] = []
        const person = await f.cli(['approve', '--config', f.config], f.env, { confirm: async approval => (shown.push(approval), true) })
        expect(person.status).toBe(0)
        expect(shown).toEqual([{ title: `Upgrade cockpit from ${installedPackageMetadata.version} to 9.9.9`,
            why: 'this installs a new package version, with Safe Chain\'s minimum package age check waived for @b00dea/cockpit only',
            details: [`runs ${EXEMPTION}=@b00dea/cockpit npm install --save-dev --save-exact @b00dea/cockpit@9.9.9`,
                `then ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${f.config}`,
                'then commits the files it changed on main as "chore: upgrade cockpit to 9.9.9"'] },
        // Something else may write while the install runs, so the person sees the exact list before it is staged.
        { title: 'Commit the upgrade to 9.9.9 as "chore: upgrade cockpit to 9.9.9"',
            why: 'these files changed while the upgrade ran; one that something else changed meanwhile would be committed with it',
            details: ['AGENTS.md', 'package-lock.json', 'package.json'] }])
        expect(f.calls().slice(1)).toEqual(['npm install --save-dev --save-exact @b00dea/cockpit@9.9.9 exempt=@b00dea/cockpit',
            `cockpit sync --config ${f.config} exempt=`])
        expect(f.git('log', '-1', '--format=%s', '--name-only').trim().split('\n').filter(Boolean))
            .toEqual(['chore: upgrade cockpit to 9.9.9', 'AGENTS.md', 'package-lock.json', 'package.json'])
        // Staged by explicit path: a file the upgrade did not write stays untracked.
        expect(f.git('status', '--porcelain')).toBe('?? notes.md\n')
        expect(f.pending()).toEqual([])
    })

    it('ends with the checklist in order: a branch when the tree was dirty or the branch is the default, the exact files, then check and doctor', async () => {
        const dirty = repository({ branch: 'topic' })
        writeFileSync(join(dirty.project, 'notes.md'), 'unrelated\n')
        const run = await dirty.cli(['upgrade', '9.9.9', '--config', dirty.config, '--json'])
        expect(run.status).toBe(0)
        const check = `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config ${dirty.config}`
        const doctor = `./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config ${dirty.config}`
        expect(run.json().result.next.split('\n')).toEqual([
            'start a branch first: git switch -c cockpit-9.9.9 origin/main (best run before the upgrade)',
            "review git diff, then commit exactly the files the upgrade changed: git add -- AGENTS.md package-lock.json package.json && git commit -m 'chore: upgrade cockpit to 9.9.9' -- AGENTS.md package-lock.json package.json",
            `run ${check}, then ${doctor}`,
        ])
        // A clean work branch with an upstream needs no new branch; a person reads each step on its own line.
        // The root is named through a link, and the files are still named from it.
        const clean = repository({ branch: 'topic' })
        const linked = `${clean.project}-link`
        symlinkSync(clean.project, linked)
        roots.push(linked)
        const config = join(linked, 'cockpit.toml')
        const human = await clean.cli(['upgrade', '9.9.9', '--config', config])
        expect(human.status).toBe(0)
        expect(human.stdout).toContain("\nnext: review git diff, then commit exactly the files the upgrade changed: git add -- AGENTS.md package-lock.json package.json && git commit -m 'chore: upgrade cockpit to 9.9.9' -- AGENTS.md package-lock.json package.json\n"
            + `next: run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config ${config}, then ./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config ${config}\n`)
        expect(human.stdout).not.toContain('git switch')
    })

    it('refuses --commit before installing while anything is staged, and commits nothing when a file it changed held edits', async () => {
        const staged = repository({ branch: 'topic' })
        writeFileSync(join(staged.project, 'notes.md'), 'unrelated\n')
        staged.git('add', '--', 'notes.md')
        const refused = await staged.cli(['upgrade', '9.9.9', '--commit', '--config', staged.config, '--json'])
        expect(refused.status).toBe(2)
        expect(refused.json().diagnostics).toEqual([expect.objectContaining({ code: 'UPGRADE_COMMIT_REFUSED', message: expect.stringContaining('notes.md') })])
        expect(staged.calls()).toEqual([])
        // Edits already in package.json would ride along under the upgrade's message, so nothing is committed.
        const edited = repository({ branch: 'topic' })
        writeFileSync(join(edited.project, 'package.json'), '{ "edited": true }\n')
        const kept = await edited.cli(['upgrade', '9.9.9', '--commit', '--config', edited.config, '--json'])
        expect(kept.status).toBe(2)
        expect(kept.json().diagnostics).toEqual([expect.objectContaining({ code: 'UPGRADE_COMMIT_FAILED', message: expect.stringContaining('package.json') })])
        expect(edited.git('log', '-1', '--format=%s').trim()).toBe('Create synthetic cockpit')
        expect(edited.git('diff', '--cached', '--name-only')).toBe('')
    })
})
