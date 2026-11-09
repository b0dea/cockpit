/**
 * Owns `cockpit upgrade`: move the exact pin of the installed package, then re-run `sync` in a new
 * process so the new version renders the generated files (this process holds the old code).
 *
 * The pin is exact because `check` refuses a running version that differs from it, so the install
 * must be exact too. The package manager comes from the single lockfile at the cockpit root. Every
 * child process crosses the supplied `execute` / `executeForeground`, which production binds to
 * `environment-exec/execute.ts`; sync's own refusals and exit code pass through unchanged.
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ExecuteProbeOutcome, ForegroundProcessInput, ForegroundProcessOutcome } from '../environment-exec/execute.js'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import { readLatestRelease, type ReleaseMetadataTransport } from '../freshness.js'
import { formatShellCommand } from '../fix-catalogue.js'
import { EXACT_DEV_INSTALL } from '../init/derive.js'
import type { Diagnostic } from '../diagnostics.js'
import { installedPackageMetadata } from '../package-metadata.js'
import { ENVIRONMENT_CODES, errorCause, hasErrorCode, tryParseJson, type ExecutionStep } from './contract.js'
import { resolveExecutable, resolveExecutablePath, type ResolvedExecutable } from './executable.js'

export interface UpgradeInput {
    readonly configPath: string
    readonly version?: string
    readonly dryRun: boolean
    readonly env: Readonly<Record<string, string>>
}

export interface UpgradeDependencies {
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    readonly executeForeground: (input: ForegroundProcessInput) => Promise<ForegroundProcessOutcome>
    readonly releaseTransport?: () => ReleaseMetadataTransport
}

export interface UpgradeOutcome {
    readonly status: number
    readonly result: unknown
    readonly diagnostics: readonly Diagnostic[]
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb'] as const
// What a package manager's minimum-package-age filter (a supply-chain wrapper around npm) prints when it
// hid releases; its answer is then an older version, not the registry's latest.
const AGE_FILTER_NOTICE = /minimum package age/i
// Lines of package-manager output that say why an install failed. Runtime warnings are noise, and a
// wrapper's "to disable this check" hint is a bypass cockpit never repeats.
const INSTALL_CAUSE = /ERR_PNPM_|npm error|npm ERR!|\b404\b|E404|No matching version|minimum package age|\berror\b/i
const INSTALL_NOISE = /\(node:\d+\)|DeprecationWarning|--trace-deprecation|disable this check|--[a-z-]*skip[a-z-]*/i
const LOOKUP_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 600_000

// Each call site writes its code and fix as literals so the troubleshooting index captures them.
function refused(diagnostic: Diagnostic, status = 2): UpgradeOutcome {
    return { status, result: null, diagnostics: [diagnostic] }
}

/** Orders two versions; a prerelease sorts before its release, and prerelease identifiers compare as semver says. */
function compareVersions(a: string, b: string): number {
    const [x, y] = [VERSION.exec(a)!, VERSION.exec(b)!]
    for (let i = 1; i <= 3; i++) if (x[i] !== y[i]) return Number(x[i]) < Number(y[i]) ? -1 : 1
    if (x[4] === y[4]) return 0
    if (x[4] === undefined || y[4] === undefined) return x[4] === undefined ? 1 : -1
    const [p, q] = [x[4].split('.'), y[4].split('.')]
    for (let i = 0; i < Math.max(p.length, q.length); i++) {
        if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1
        if (p[i] === q[i]) continue
        const numeric = [/^\d+$/.test(p[i]!), /^\d+$/.test(q[i]!)]
        if (numeric[0] && numeric[1]) return Number(p[i]) < Number(q[i]) ? -1 : 1
        if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1
        return p[i]! < q[i]! ? -1 : 1
    }
    return 0
}

function step(executable: ResolvedExecutable, cwd: string, env: Readonly<Record<string, string>>, id: string,
    args: readonly string[], timeoutMs: number): ExecutionStep {
    return {
        id, argv: [executable.canonicalPath, ...args] as readonly [string, ...string[]],
        argv0: executable.invocationPath, cwd, env, timeoutMs,
        stdoutLimitBytes: 65_536, stderrLimitBytes: 65_536,
        outputOverflow: 'retain-tail' as const, failureOutput: 'stderr-tail' as const,
        paths: [], ports: [], labels: { purpose: id }, expected: [],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256,
            maxBytes: 536_870_912, argvIndexes: [0], executable: true as const, executionMode: executable.executionMode }],
        filesystemChecks: [], compensation: [],
    }
}

async function lockfilesAt(root: string): Promise<string[]> {
    const found: string[] = []
    for (const name of LOCKFILES) {
        try { await stat(join(root, name)); found.push(name) }
        catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error }
    }
    return found
}

/** The `Upgrade:` lines of every changelog entry after `from` up to and including `to`. */
function upgradeNotes(changelog: string, from: string, to: string): string[] {
    const notes: string[] = []
    let inRange = false
    for (const line of changelog.split('\n')) {
        const heading = /^## (\S+)\s*$/.exec(line)
        if (heading) inRange = VERSION.test(heading[1]!) && compareVersions(heading[1]!, from) > 0 && compareVersions(heading[1]!, to) <= 0
        else if (inRange && /\bUpgrade:/.test(line)) notes.push(line.trim().replace(/^[-*]\s+/, ''))
    }
    return notes
}

/**
 * The one version `npm view <name> version --json` answered. A wrapper around npm may print notices on
 * the same stream, so the answer is found among them: a whole-line JSON value, or a list npm spread
 * over lines from `[` to `]`. A one-element list is the same answer; several versions are none.
 */
function publishedVersion(stdout: string): string | undefined {
    const values: unknown[] = []
    const lines = stdout.split('\n').map(line => line.trim())
    for (let index = 0; index < lines.length; index++) {
        if (lines[index] === '[') {
            const end = lines.indexOf(']', index)
            if (end < 0) return undefined
            values.push(tryParseJson(lines.slice(index, end + 1).join('')))
            index = end
        } else values.push(tryParseJson(lines[index]!))
    }
    const versions = values.flatMap(parsed => {
        const value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed
        return typeof value === 'string' && VERSION.test(value) ? [value] : []
    })
    return versions.length === 1 ? versions[0] : undefined
}

export async function runUpgrade(input: UpgradeInput, dependencies: UpgradeDependencies): Promise<UpgradeOutcome> {
    const { name, version: installed } = installedPackageMetadata
    const configPath = resolve(input.configPath)
    const root = dirname(configPath)
    const npmPage = (version: string) => `https://www.npmjs.com/package/${name}/v/${version}`

    const found = await lockfilesAt(root)
    const lockfile = found.length === 1 ? EXACT_DEV_INSTALL[found[0]!] : undefined
    if (!lockfile) return refused({ severity: 'error' as const, code: 'UPGRADE_PACKAGE_MANAGER_UNKNOWN' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_PACKAGE_MANAGER_UNKNOWN,
        message: found.length === 0 ? `no lockfile in ${root}, so the package manager is unknown`
            : `${found.join(', ')} in ${root} ${found.length > 1 ? 'name more than one package manager' : 'is not a lockfile upgrade supports'}`,
        fix: 'keep exactly one of package-lock.json, pnpm-lock.yaml or yarn.lock at the cockpit root and put its package manager (npm, pnpm or yarn) on PATH, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml>' })
    const manager = await resolveExecutable(lockfile.manager, input.env)
    if (manager.state !== 'available') return refused({ severity: 'error' as const, code: 'UPGRADE_PACKAGE_MANAGER_UNKNOWN' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_PACKAGE_MANAGER_UNKNOWN,
        message: `${lockfile.manager} is not on PATH: ${manager.reason}`, fix: 'keep exactly one of package-lock.json, pnpm-lock.yaml or yarn.lock at the cockpit root and put its package manager (npm, pnpm or yarn) on PATH, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml>' })

    let target = input.version
    if (target === undefined) {
        const npm = await resolveExecutable('npm', input.env)
        if (npm.state !== 'available') return refused({ severity: 'error' as const, code: 'UPGRADE_REGISTRY_UNREACHABLE' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_REGISTRY_UNREACHABLE,
            message: `npm is needed to look up the latest ${name} and is not on PATH: ${npm.reason}`, fix: 'check the network, the registry login and that npm is on PATH, or name the version: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml> <version>' })
        const lookup = step(npm.value, root, input.env, 'upgrade:latest', ['view', name, 'version', '--json'], LOOKUP_TIMEOUT_MS)
        const outcome = authenticatedExecutionOutcome(await dependencies.execute(lookup), lookup)
        const answer = outcome?.kind === 'complete' ? outcome.stdout.toString('utf8') : ''
        const published = outcome?.kind === 'complete' ? publishedVersion(answer) : undefined
        if (published === undefined) return refused({ severity: 'error' as const, code: 'UPGRADE_REGISTRY_UNREACHABLE' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_REGISTRY_UNREACHABLE,
            message: `the registry did not give the latest ${name} version (${outcome?.kind === 'complete' ? `the answer was not one version: ${answer.trim().split('\n').slice(0, 3).join(' | ').slice(0, 256)}` : outcome ? `${outcome.code}: ${outcome.stderr.toString('utf8').trim().split('\n').slice(0, 2).join(' | ').slice(0, 256)}` : 'the lookup could not be authenticated'})`,
            fix: 'check the network, the registry login and that npm is on PATH, or name the version: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml> <version>' })
        if (AGE_FILTER_NOTICE.test(answer) && compareVersions(published, installed) <= 0) {
            const real = await readLatestRelease(dependencies.releaseTransport)
            const latest = real.kind === 'known' && VERSION.test(real.latestVersion) ? real.latestVersion : undefined
            return refused({ severity: 'error' as const, code: 'UPGRADE_LATEST_FILTERED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_LATEST_FILTERED,
                message: `the package manager's minimum package age filter hid newer ${name} releases, so its latest answer (${published}) says nothing about whether installed ${installed} is current; `
                    + (latest ? `the registry's latest is ${latest}, so run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade ${latest} --config <your cockpit.toml>` : `the registry's latest could not be read (${real.kind === 'unknown' ? real.reason : 'unexpected answer'})`),
                fix: 'name the latest version the message gives (or look it up on the registry) instead of asking the package manager: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade <version> --config <your cockpit.toml>' })
        }
        target = published
    } else if (!VERSION.test(target)) return refused({ severity: 'error' as const, code: 'UPGRADE_VERSION_INVALID' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_VERSION_INVALID, target: '<version>',
        message: `"${target}" is not an exact version`, fix: 'give a full version such as 1.2.3, not a range or tag' })

    const order = compareVersions(target, installed)
    // Already at the requested or latest version is a finished upgrade, not a failure: it runs nothing
    // and exits 0, so an agent asked to upgrade does not treat a current install as broken.
    if (order === 0 || order < 0 && input.version === undefined) return { status: 0, result: { from: installed, to: installed, packageManager: lockfile.manager, dryRun: input.dryRun },
        diagnostics: [{ severity: 'info' as const, code: 'UPGRADE_ALREADY_CURRENT' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_ALREADY_CURRENT,
            message: order === 0 ? `already on ${installed}` : `installed ${installed} is newer than the latest published ${target}`,
            fix: 'nothing to upgrade; to move to another version name it: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml> <version>' }] }

    const spec = `${name}@${target}`
    const installArgv = [lockfile.manager, lockfile.verb, ...lockfile.flags, spec]
    // Sync runs from the newly installed package's own entrypoint with this Node: a package manager's
    // shim (npx, pnpm's .bin script) is a launcher the guard cannot prove, so printing it would send an
    // agent to a command that is asked about or refused.
    const syncArgv = [`./node_modules/${name}/bin/cockpit.mjs`, 'sync', '--config', configPath]
    const result = { from: installed, to: target, packageManager: lockfile.manager,
        install: formatShellCommand(installArgv), sync: formatShellCommand(syncArgv), dryRun: input.dryRun }
    if (input.dryRun) return { status: 0, diagnostics: [],
        result: { ...result, next: 'nothing was run; drop --dry-run to install and sync' } }

    const install = step(manager.value, root, input.env, 'upgrade:install', installArgv.slice(1), INSTALL_TIMEOUT_MS)
    const installOutcome = authenticatedExecutionOutcome(await dependencies.execute(install), install)
    const installOutput = installOutcome?.kind === 'complete' ? '' : installOutcome ? `${installOutcome.stdout.toString('utf8')}\n${installOutcome.stderr.toString('utf8')}` : ''
    const installLines = installOutput.split('\n').map(line => line.trim()).filter(line => line !== '' && !INSTALL_NOISE.test(line))
    const installCause = (installLines.some(line => INSTALL_CAUSE.test(line)) ? installLines.filter(line => INSTALL_CAUSE.test(line)) : installLines).slice(-4)
    if (installOutcome?.kind !== 'complete') return refused({ severity: 'error' as const, code: 'UPGRADE_INSTALL_FAILED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_INSTALL_FAILED,
        message: `${result.install} failed (${installOutcome ? `${installOutcome.code}, exit ${installOutcome.execution.exitCode}: ${installCause.join(' | ').slice(0, 512)}` : 'the outcome could not be authenticated'})`
            + (AGE_FILTER_NOTICE.test(installOutput) ? `; the package manager's package-age filter refused ${spec}, a release that is too new: wait until it is older than the filter's minimum age, or exempt ${name} in your package manager's age-filter settings` : ''),
        fix: 'fix what the package manager reported (is the version published?), then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml> <version>' })

    const node = await resolveExecutablePath(process.execPath)
    if (node.state !== 'available') return refused({ severity: 'error' as const, code: 'UPGRADE_SYNC_FAILED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_SYNC_FAILED,
        message: `${spec} is installed but the running Node could not be resolved: ${node.reason}`, fix: 'act on what sync reported above, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>' })
    const synced = await dependencies.executeForeground({ executable: node.value,
        argv: [join(root, 'node_modules', name, 'bin', 'cockpit.mjs'), ...syncArgv.slice(1)], cwd: root, env: input.env })
    if (synced.kind !== 'complete' || synced.exitCode !== 0) return refused({ severity: 'error' as const, code: 'UPGRADE_SYNC_FAILED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_SYNC_FAILED,
        message: `${spec} is installed but sync did not finish (${synced.kind === 'refusal' ? synced.code : `exit ${synced.exitCode}`}); the generated files are still those of ${installed}`,
        fix: 'act on what sync reported above, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>' }, synced.exitCode === 0 ? 1 : synced.exitCode)

    let notes: string[]
    try { notes = upgradeNotes(await readFile(join(root, 'node_modules', name, 'CHANGELOG.md'), 'utf8'), installed, target) }
    catch (error) {
        return { status: 0, diagnostics: [], result: { ...result,
            upgradeSteps: `the installed package's CHANGELOG.md could not be read (${hasErrorCode(error, 'ENOENT') ? 'missing' : errorCause(error)}); release notes: ${npmPage(target)}`,
            next: 'review git diff, then commit package.json, the lockfile and the regenerated files together' } }
    }
    return { status: 0, diagnostics: [], result: { ...result,
        upgradeSteps: notes.length === 0 ? 'the changelog lists no Upgrade: steps between these versions' : notes,
        next: 'review git diff, then commit package.json, the lockfile and the regenerated files together' } }
}
