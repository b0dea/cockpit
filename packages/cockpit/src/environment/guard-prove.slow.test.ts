import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installedPackageMetadata } from '../package-metadata.js'

const launcher = fileURLToPath(new URL('../../bin/cockpit.mjs', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-guard-prove-')))
const home = join(scratch, 'home')
const root = join(scratch, 'estate', 'cockpit')
const sibling = join(scratch, 'estate', 'api')
const report = join(root, '.cockpit', 'local', 'guard-prove', `${installedPackageMetadata.version}.json`)
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(scratch, 'state'), CODEX_HOME: undefined }
const git = (cwd: string, ...args: string[]) => {
    const run = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args], { cwd, encoding: 'utf8', env })
    expect(run.status, run.stderr).toBe(0)
}
const cockpit = (...args: string[]) => {
    const run = spawnSync(process.execPath, [launcher, ...args, '--config', join(root, 'cockpit.toml')], { cwd: root, encoding: 'utf8', env })
    return { status: run.status, stderr: run.stderr, stdout: run.stdout, json: args.includes('--json') && run.stdout ? JSON.parse(run.stdout) : undefined }
}
const writeCases = (cases: readonly object[]) => writeFileSync(join(root, 'guard-cases.json'), JSON.stringify(cases))

type Row = { source: string; id: string; harness: string; command: string; decision: string; expect?: string; matches: boolean | null; regression: boolean }
type Report = { cockpitVersion: string; provedAt: string; status: string; errors: { code: string }[]; checkout: Record<string, unknown>; results: Row[] }
const readReport = (path = report) => JSON.parse(readFileSync(path, 'utf8')) as Report

// The cockpit roots whose guard the machine's check records, from the home's per-root digests.
function recordedRoots(): string[] {
    const records = join(home, '.cockpit', 'guards', 'roots')
    return (readdirSync(records, { recursive: true }) as string[]).filter(path => path.endsWith('bash-guard.sha256')).map(path => `/${path.split('/').slice(0, -1).join('/')}`)
}

// A cockpit beside a sibling repository, synced and committed as a team keeps it, with Git
// guard controls left dirty in the checkout: that state changes how the guard answers a stash.
beforeAll(() => {
    mkdirSync(home, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'README.md'), 'Synthetic api.\n')
    git(sibling, 'init', '--quiet')
    git(sibling, 'add', 'README.md')
    git(sibling, 'commit', '--quiet', '-m', 'Synthetic api')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'cockpit.toml'), [
        '[cockpit]', 'name = "proving"', 'siblings_root = ".."', '',
        '[[sibling]]', 'slug = "api"', 'dir = "api"', 'mount = "always"', 'acquire = "none"', 'var = "API_DIR"', 'purpose = "Synthetic api"', '',
        '[ports]', 'bases = {}', '',
        '[guards]', 'hosted_db_hosts = ["db.example.test"]', 'vendor_endpoint_hosts = ["*.vendor.example.test"]', 'cases = "guard-cases.json"', '',
    ].join('\n'))
    writeFileSync(join(root, 'README.md'), 'Synthetic cockpit.\n')
    writeCases([
        { id: 'stash', command: 'git stash', expect: 'allow' },
        { id: 'sibling-secret', command: 'cat .env', cwd: '../api', expect: 'refuse' },
        { id: 'notes', command: 'echo x > notes.md' },
    ])
    git(root, 'init', '--quiet')
    const sync = cockpit('sync')
    expect(sync.status, sync.stderr).toBe(0)
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', 'Synthetic cockpit')
    appendFileSync(join(root, '.codex', 'config.toml'), '\n# a local edit\n')
}, 120_000)

// The hook a Codex session runs, judged in the checkout as it stands.
function inPlaceCodex(command: string): string {
    const hook = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command
    const run = spawnSync('/bin/sh', ['-c', hook], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home },
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command } }) })
    expect(run.status, run.stderr).toBe(0)
    return run.stdout ? JSON.parse(run.stdout).hookSpecificOutput.permissionDecision : 'allow'
}

describe('guard prove', () => {
    it('drives every standard probe and declared case through each harness hook in a clean scratch clone, and records the report doctor looks for', () => {
        // The control: in this dirty checkout the same hook refuses the stash a clean clone allows.
        expect(inPlaceCodex('git stash')).toBe('deny')
        const before = cockpit('doctor', '--json')
        expect(before.json.diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_PROVE_REPORT_MISSING', severity: 'warning' }))
        const check = statSync(join(home, '.cockpit', 'guards', 'check.sh'))
        expect(recordedRoots()).toEqual([root])

        const proved = cockpit('guard', 'prove', '--json', '--real-sessions')

        expect(proved.status, `${proved.stdout}\n${proved.stderr}`).toBe(0)
        expect(proved.json.result).toMatchObject({ report, mismatches: [], regressions: [],
            checkout: { mode: 'scratch', branch: 'cockpit-guard-prove', upstream: null },
            harnesses: [expect.objectContaining({ harness: 'claudecode' }), expect.objectContaining({ harness: 'codexcli' })],
            skipped: [expect.objectContaining({ harness: 'opencode' })] })
        // Real sessions are named, never run: each costs a model call and the model chooses the call.
        expect(proved.json.result.realSessions).toMatchObject({ run: false,
            commands: [expect.stringMatching(/^claude -p --output-format json /), expect.stringMatching(/^codex exec --json -C /)] })
        const rows = readReport().results
        for (const harness of ['claudecode', 'codexcli']) {
            const own = rows.filter(row => row.harness === harness)
            expect(own.filter(row => row.source === 'cases').map(row => [row.id, row.decision, row.matches])).toEqual([
                ['stash', harness === 'claudecode' ? 'allow' : 'none', true],
                ['sibling-secret', 'deny', true],
                ['notes', harness === 'claudecode' ? 'allow' : 'none', null],
            ])
            const standard = own.filter(row => row.source === 'standard')
            expect(standard.map(row => row.id)).toEqual(expect.arrayContaining(['secret-env', 'credential-aws', 'host-database', 'host-vendor',
                'push-protected', 'push-force', 'live-key', 'live-key-placeholder', 'control-codex-hooks-write', 'installed-cockpit',
                'wrapper-shell', 'case-secret', 'allow-git-status']))
            expect(standard.filter(row => row.matches !== true), harness).toEqual([])
        }
        expect(cockpit('doctor', '--json').json.diagnostics.map((row: { code: string }) => row.code)).not.toContain('GUARD_PROVE_REPORT_MISSING')
        // The scratch sync records its guard in a home of its own: the person's check and its records are untouched.
        expect(recordedRoots()).toEqual([root])
        expect(statSync(join(home, '.cockpit', 'guards', 'check.sh'))).toMatchObject({ ino: check.ino, mtimeMs: check.mtimeMs })
        // The user's checkout is untouched: only the ignored report is new.
        expect(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout).toBe(' M .codex/config.toml\n')
    }, 300_000)

    it('fails on an answer that differs from its expectation, and on a case allowed now that was refused under the previous version, on every rerun', () => {
        expect(existsSync(report)).toBe(true)
        const directory = join(root, '.cockpit', 'local', 'guard-prove')
        // The previous version's report saw the notes write refused; now it is allowed, with no expectation to catch it.
        const previous = readReport()
        previous.cockpitVersion = '0.0.1'
        previous.provedAt = '2000-01-01T00:00:00.000Z'
        for (const row of previous.results) if (row.id === 'notes') row.decision = 'deny'
        writeFileSync(join(directory, '0.0.1.json'), JSON.stringify(previous))
        // An older report with a row no version wrote is named, never read as a row.
        writeFileSync(join(directory, '0.0.0.json'), JSON.stringify({ ...previous, cockpitVersion: '0.0.0', provedAt: '1999-01-01T00:00:00.000Z', results: [null] }))
        writeCases([
            { id: 'stash', command: 'git stash', expect: 'allow' },
            { id: 'readme-refused', command: 'cat README.md', expect: 'refuse' },
            { id: 'notes', command: 'echo x > notes.md' },
        ])
        // An uncommitted edit: the hooks in force were synced from it, so it is what gets proved.
        const toml = join(root, 'cockpit.toml')
        writeFileSync(toml, readFileSync(toml, 'utf8').replace('hosted_db_hosts = ["db.example.test"]', 'hosted_db_hosts = ["db2.example.test", "db.example.test"]'))

        const proved = cockpit('guard', 'prove')

        expect(proved.status).toBe(2)
        const lines = proved.stderr.trim().split('\n')
        expect(lines.filter(line => line.includes('GUARD_PROVE_MISMATCH'))).toEqual([
            expect.stringMatching(/\[claudecode:readme-refused\].*cat README\.md.*expected refuse, got allow/),
            expect.stringMatching(/\[codexcli:readme-refused\].*expected refuse, got none/),
        ])
        expect(lines.filter(line => line.includes('GUARD_PROVE_REGRESSION'))).toEqual([
            expect.stringMatching(/\[claudecode:notes\].*echo x > notes\.md.*was deny/),
            expect.stringMatching(/\[codexcli:notes\]/),
        ])
        expect(lines.filter(line => line.includes('GUARD_PROVE_PREVIOUS_UNREADABLE'))).toEqual([expect.stringContaining('0.0.0.json')])
        expect(proved.stdout).toMatch(/2 mismatches, 2 regressions/)
        expect(proved.stdout).toContain('0.0.1.json')
        expect(readReport().results.filter(row => row.id === 'host-database').map(row => [row.command, row.matches]))
            .toEqual([['psql -h db2.example.test', true], ['psql -h db2.example.test', true]])

        // A rerun replaces this version's report; the regression stays until the case is refused again.
        const rerun = cockpit('guard', 'prove', '--json')

        expect(rerun.status).toBe(2)
        expect(rerun.json.result.regressions.map((row: Row) => `${row.harness}:${row.id}`)).toEqual(['claudecode:notes', 'codexcli:notes'])
        expect(rerun.json.diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_PROVE_PREVIOUS_UNREADABLE', severity: 'warning' }))
        expect(readReport().status).toBe('failed')
        expect(cockpit('doctor', '--json').json.diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_PROVE_REPORT_FAILING' }))
    }, 300_000)

    it('runs in place and records the checkout state when no scratch clone can hold the cockpit', () => {
        // Nothing is committed, so a clone would have no cockpit.toml to sync.
        const fresh = join(scratch, 'fresh')
        mkdirSync(join(fresh, 'docs'), { recursive: true })
        writeFileSync(join(fresh, 'cockpit.toml'), [
            '[cockpit]', 'name = "fresh"', 'siblings_root = "."', '',
            '[[sibling]]', 'slug = "docs"', 'dir = "docs"', 'mount = "always"', 'acquire = "none"', 'var = "DOCS_DIR"', 'purpose = "Notes"', '',
            '[ports]', 'bases = {}', '',
        ].join('\n'))
        git(fresh, 'init', '--quiet')
        const run = (...args: string[]) => {
            const result = spawnSync(process.execPath, [launcher, ...args, '--config', join(fresh, 'cockpit.toml')], { cwd: fresh, encoding: 'utf8', env })
            return { status: result.status, stderr: result.stderr, json: result.stdout ? JSON.parse(result.stdout) : undefined }
        }
        expect(run('sync', '--json').status).toBe(0)

        const proved = run('guard', 'prove', '--json')

        expect(proved.status, JSON.stringify(proved.json?.result?.mismatches)).toBe(0)
        expect(proved.json.result.checkout).toMatchObject({ mode: 'in-place', reason: expect.stringContaining('no commit'),
            dirty: expect.arrayContaining(['cockpit.toml']) })
        expect(proved.json.diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_PROVE_IN_PLACE', severity: 'warning' }))

        // A listed harness with no hook leaves no answer row behind, so the report's status carries the failure.
        rmSync(join(fresh, '.codex', 'hooks.json'))
        const unproved = run('guard', 'prove', '--json')

        expect(unproved.status).toBe(2)
        expect(unproved.json.diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_PROVE_HOOK_UNAVAILABLE', target: 'codexcli' }))
        expect(readReport(unproved.json.result.report)).toMatchObject({ status: 'failed', errors: [expect.objectContaining({ code: 'GUARD_PROVE_HOOK_UNAVAILABLE' })] })
    }, 300_000)
})
