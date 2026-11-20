/**
 * Owns `cockpit upgrade`: move the exact pin of the installed package, then re-run `sync` in a new
 * process so the new version renders the generated files (this process holds the old code).
 *
 * The pin is exact because `check` refuses a running version that differs from it, so the install
 * must be exact too. The package manager comes from the single lockfile at the cockpit root. Every
 * child process crosses the supplied `execute` / `executeForeground`, which production binds to
 * `environment-exec/execute.ts`; sync's own refusals and exit code pass through unchanged.
 *
 * Installing a release is a person's step: an agent's run stops before the install and leaves it for
 * `cockpit approve`. Comparing the Git tree before and after names the files the upgrade wrote, which
 * the next steps list and `--commit` stages by path.
 */
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { parse as parseToml, TomlError } from 'smol-toml'
import { readBoundedInput } from '../config/load.js'
import { Guards } from '../schema.js'
import type { ExecuteProbeOutcome, ForegroundProcessInput, ForegroundProcessOutcome } from '../environment-exec/execute.js'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import { readLatestRelease, type ReleaseMetadataTransport } from '../freshness.js'
import { cockpitCommand, formatShellCommand } from '../fix-catalogue.js'
import { EXACT_DEV_INSTALL } from '../init/derive.js'
import type { Diagnostic } from '../diagnostics.js'
import { EXIT_CODES } from '../invocation.js'
import type { Approval } from '../operator-confirmation.js'
import { installedPackageMetadata } from '../package-metadata.js'
import { sha256Hex } from '../sha256.js'
import { ENVIRONMENT_CODES, errorCause, hasErrorCode, tryParseJson, type ExecutionStep } from './contract.js'
import { GIT_CHILD_CONFIG, locateExecutable, resolveExecutable, resolveExecutablePath, type ResolvedExecutable } from './executable.js'

export interface UpgradeInput {
    readonly configPath: string
    readonly version?: string
    readonly dryRun: boolean
    /** Stage exactly the files the upgrade changed, by path, and commit them. */
    readonly commit?: boolean
    readonly env: Readonly<Record<string, string>>
    /** An agent tool's run: the install waits for a person, so it is described and left for approve. */
    readonly agent?: boolean
    /** The run `cockpit approve` makes for a person: they answer this before anything is installed. */
    readonly confirm?: (approval: Approval) => Promise<boolean>
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
// Safe Chain's list of packages its minimum package age check skips.
const AGE_EXEMPTION = 'SAFE_CHAIN_MINIMUM_PACKAGE_AGE_EXCLUSIONS'
// What npm and pnpm print when no published version satisfies the request, which is how a release an
// age filter hid looks to the package manager when the filter's notice went to another process's output.
const NO_MATCHING_VERSION = /ERR_PNPM_NO_MATCHING_VERSION|ETARGET|No matching version/i
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

// `whole`: a read that is parsed, so output past the bound fails the step instead of losing its start.
function step(executable: ResolvedExecutable, cwd: string, env: Readonly<Record<string, string>>, id: string,
    args: readonly string[], timeoutMs: number, output: 'tail' | 'whole' = 'tail'): ExecutionStep {
    return {
        id, argv: [executable.canonicalPath, ...args] as readonly [string, ...string[]],
        argv0: executable.invocationPath, cwd, env, timeoutMs,
        stdoutLimitBytes: output === 'whole' ? 4_194_304 : 65_536, stderrLimitBytes: 65_536,
        ...output === 'whole' ? {} : { outputOverflow: 'retain-tail' as const }, failureOutput: 'stderr-tail' as const,
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

/**
 * The Git state an upgrade is judged against: the branch, origin's default branch, what
 * is staged, and a digest of every changed or untracked file, keyed by its path from the cockpit root.
 * Comparing two of these names exactly the files the upgrade wrote.
 */
type Tree = Readonly<{ git: ResolvedExecutable; branch: string | null; defaultRef: string | undefined
    staged: readonly string[]; files: ReadonlyMap<string, string> }>

const MAX_HASHED_BYTES = 16_777_216
// A ref printed into a command a person pastes stays plain; anything else is named as a placeholder.
const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/

/** The tree at `root`, or why it cannot be read; reads run with repository hooks and fsmonitor off. */
async function observeTree(root: string, env: Readonly<Record<string, string>>,
    execute: UpgradeDependencies['execute']): Promise<Tree | string> {
    const git = await resolveExecutable('git', env)
    if (git.state !== 'available') return `git is not on PATH: ${git.reason}`
    const run = async (id: string, args: readonly string[], cwd: string) => {
        const read = step(git.value, cwd, env, id, [...GIT_CHILD_CONFIG, ...args], LOOKUP_TIMEOUT_MS, 'whole')
        const outcome = authenticatedExecutionOutcome(await execute(read), read)
        return outcome?.kind === 'complete' ? outcome.stdout.toString('utf8') : undefined
    }
    const top = (await run('upgrade:git-top', ['rev-parse', '--show-toplevel'], root))?.trim()
    if (!top) return `${root} is not in a Git repository`
    const status = await run('upgrade:git-status', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], top)
    if (status === undefined) return `git status did not answer in ${top}`
    let branch: string | null = null
    const staged: string[] = []
    const paths: string[] = []
    const records = status.split('\0')
    for (let index = 0; index < records.length; index++) {
        const record = records[index]!
        const fields = record.split(' ')
        if (record.startsWith('# branch.head ')) branch = record === '# branch.head (detached)' ? null : record.slice(14)
        // Ordinary, renamed (its source follows in the next record), unmerged and untracked entries.
        else if (/^[12u] /.test(record)) {
            const path = fields.slice({ 1: 8, 2: 9, u: 10 }[fields[0] as '1' | '2' | 'u']).join(' ')
            const moved = fields[0] === '2' ? [records[++index]!] : []
            paths.push(path, ...moved)
            if (fields[1]![0] !== '.' || fields[0] === 'u') staged.push(path, ...moved)
        } else if (record.startsWith('? ')) paths.push(record.slice(2))
        else if (record !== '' && !record.startsWith('# ')) return `git status printed a record cockpit does not read: ${record.slice(0, 64)}`
    }
    // Git names the top by its real path, so paths are made relative to the root's real path, which a
    // linked spelling of the root would otherwise turn into a walk out of the repository.
    let real: string
    try { real = await realpath(root) } catch (error) { return `${root} could not be resolved: ${errorCause(error)}` }
    const files = new Map<string, string>()
    for (const path of paths) {
        const absolute = join(top, path)
        let digest: string
        // A link is its target's spelling and a large file its size and time: neither is followed or read whole.
        try {
            const facts = await lstat(absolute)
            digest = facts.isSymbolicLink() ? `link:${await readlink(absolute)}`
                : !facts.isFile() ? 'not-a-file' : facts.size > MAX_HASHED_BYTES ? `size:${facts.size}:${facts.mtimeMs}` : sha256Hex(await readFile(absolute))
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) return `${absolute} could not be read: ${errorCause(error)}`
            digest = 'missing'
        }
        files.set(relative(real, absolute), digest)
    }
    const origin = (await run('upgrade:git-default', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], top))?.trim()
    return { git: git.value, branch, defaultRef: origin && PLAIN_REF.test(origin) ? origin : undefined,
        staged: staged.map(path => relative(real, join(top, path))), files }
}

/**
 * The command a person runs to approve a queued upgrade. Safe Chain's shell functions run `npx` inside
 * a safe-chain process that filters every package fetch through its own local proxy, configured from
 * that process's environment; the install approve starts reaches the registry through that proxy, so an
 * exemption set on the install alone is never read. The functions wrap only while `safe-chain` is on
 * PATH, so the same lookup decides when the person's command must carry the exemption itself.
 */
/**
 * The branches `[guards] protected_branches` names, with the schema's default when it names none. The field
 * is read alone, so a configuration this version would refuse elsewhere still answers; undefined when the
 * file or the field cannot be read.
 */
async function branchesNotToCommitOn(configPath: string): Promise<readonly string[] | undefined> {
    let parsed: unknown
    try {
        const read = await readBoundedInput(configPath)
        if (read.kind === 'too-large') return undefined
        parsed = parseToml(read.bytes.toString('utf8'))
    } catch (error) {
        if (error instanceof TomlError || hasErrorCode(error, 'ENOENT', 'EISDIR')) return undefined
        throw error
    }
    const guards = (parsed as { guards?: unknown }).guards
    const field = Guards.shape.protected_branches.safeParse(guards !== null && typeof guards === 'object' ? (guards as { protected_branches?: unknown }).protected_branches : undefined)
    return field.success ? field.data : undefined
}

export async function personApproveCommand(env: Readonly<Record<string, string | undefined>>, root: string): Promise<string> {
    const safeChain = await locateExecutable('safe-chain', env, root)
    return `${safeChain.state === 'present' ? `${AGE_EXEMPTION}=${installedPackageMetadata.name} ` : ''}npx --no cockpit approve`
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

    // An agent runs upgrade unprompted, so it never installs an older cockpit, whose sync would then run;
    // going back is a package-manager install, which the guard asks a person about.
    if (order < 0) return refused({ severity: 'error' as const, code: 'UPGRADE_VERSION_INVALID' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_VERSION_INVALID, target: '<version>',
        message: `${target} is older than the installed ${installed}; upgrade only moves forward`,
        fix: `to go back, a person installs it with the package manager, such as ${formatShellCommand([lockfile.manager, lockfile.verb, ...lockfile.flags, `${name}@${target}`])}, and confirms that version's sync the way it asks: npx --no cockpit approve where that version has approve, otherwise ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> --interactive in a terminal outside the agent` })
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

    const before = await observeTree(root, input.env, dependencies.execute)
    const message = `chore: upgrade cockpit to ${target}`
    if (input.commit && typeof before === 'string') return refused({ severity: 'error' as const, code: 'UPGRADE_COMMIT_REFUSED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_COMMIT_REFUSED,
        message: `--commit needs the cockpit root's Git state, and ${before}; nothing was installed`,
        fix: 'unstage what the upgrade does not write, by path, or run it where Git reads the cockpit root, then run the upgrade again; or drop --commit and commit the files its next steps name' })
    if (input.commit && typeof before !== 'string' && before.staged.length) return refused({ severity: 'error' as const, code: 'UPGRADE_COMMIT_REFUSED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_COMMIT_REFUSED,
        message: `--commit commits only what the upgrade writes, and ${before.staged.join(', ')} ${before.staged.length === 1 ? 'is' : 'are'} already staged; nothing was installed`,
        fix: 'unstage what the upgrade does not write, by path, or run it where Git reads the cockpit root, then run the upgrade again; or drop --commit and commit the files its next steps name' })
    // The consumer's branch is made before the upgrade: once its files are dirty, switching to a branch
    // from the default branch refuses wherever a changed file also differs there.
    // A branch with no upstream yet is still a branch: one made with `git switch -c` has none until it is pushed.
    // A protected branch counts as the default does, which covers a local main when origin names no default;
    // one whose protection cannot be read is treated as protected.
    const guarded = typeof before !== 'string' && before.branch !== null ? await branchesNotToCommitOn(configPath) : undefined
    const branch = typeof before !== 'string' && (before.branch === null || before.files.size > 0
        || before.defaultRef !== undefined && `origin/${before.branch}` === before.defaultRef
        || guarded === undefined || guarded.includes(before.branch))
        ? `start a branch first: git switch -c cockpit-${target} ${typeof before !== 'string' && before.defaultRef || 'origin/<default branch>'}` : undefined

    // The install and its age exemption are a person's: an agent's run leaves them for approve.
    const approveCommand = await personApproveCommand(input.env, root)
    const approve = `run \`${approveCommand}\` in ${root}, in a terminal outside the agent`
    if (input.agent) return { status: 2, result: { ...result, approve: approveCommand, next: [branch, approve].filter(Boolean).join('\n') },
        diagnostics: [{ severity: 'error' as const, code: 'UPGRADE_PERSON_REQUIRED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_PERSON_REQUIRED,
            message: `upgrading cockpit from ${installed} to ${target} installs a new package version, which a person approves; nothing was installed${branch ? `; ${branch}` : ''}`,
            fix: 'run `npx --no cockpit approve` in <the cockpit root>, in a terminal outside the agent' }] }
    // A person at approve installs past Safe Chain's minimum package age for cockpit alone, and only in
    // the install's own environment: the sync after it and every later command run without it.
    const exemption = { [AGE_EXEMPTION]: name }
    if (input.confirm && !await input.confirm({ title: `Upgrade cockpit from ${installed} to ${target}`,
        why: `this installs a new package version, with Safe Chain's minimum package age check waived for ${name} only`,
        details: [`runs ${formatShellCommand([`${AGE_EXEMPTION}=${name}`, ...installArgv])}`, `then ${result.sync}`,
            ...input.commit && typeof before !== 'string' ? [`then commits the files it changed on ${before.branch ?? 'a detached HEAD'} as "${message}"`] : []] })) {
        return { status: EXIT_CODES.cancelled, diagnostics: [], result: null }
    }

    const install = step(manager.value, root, input.confirm ? { ...input.env, ...exemption } : input.env, 'upgrade:install', installArgv.slice(1), INSTALL_TIMEOUT_MS)
    const installOutcome = authenticatedExecutionOutcome(await dependencies.execute(install), install)
    const installOutput = installOutcome?.kind === 'complete' ? '' : installOutcome ? `${installOutcome.stdout.toString('utf8')}\n${installOutcome.stderr.toString('utf8')}` : ''
    const installLines = installOutput.split('\n').map(line => line.trim()).filter(line => line !== '' && !INSTALL_NOISE.test(line))
    const installCause = (installLines.some(line => INSTALL_CAUSE.test(line)) ? installLines.filter(line => INSTALL_CAUSE.test(line)) : installLines).slice(-4)
    if (installOutcome?.kind !== 'complete') {
        // Under Safe Chain the age notice may print in the process wrapping approve, outside this output, so a
        // missing release while Safe Chain is on PATH is read as its refusal too.
        const safeChain = (await locateExecutable('safe-chain', input.env, root)).state === 'present'
        const ageRefused = AGE_FILTER_NOTICE.test(installOutput) || safeChain && NO_MATCHING_VERSION.test(installOutput)
        // Approve keeps the step after a failed install, so its rerun carries the exemption to the wrapper's filter.
        const rerun = `cd ${formatShellCommand([root])} && ${AGE_EXEMPTION}=${name} `
            + (input.confirm ? 'npx --no cockpit approve' : formatShellCommand([`./node_modules/${name}/bin/cockpit.mjs`, 'upgrade', target, '--config', configPath]))
        return refused({ severity: 'error' as const, code: 'UPGRADE_INSTALL_FAILED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_INSTALL_FAILED,
            message: `${result.install} failed (${installOutcome ? `${installOutcome.code}, exit ${installOutcome.execution.exitCode}: ${installCause.join(' | ').slice(0, 512)}` : 'the outcome could not be authenticated'})`
                + (safeChain && ageRefused ? `; Safe Chain's minimum package age check refused ${spec}, a release younger than its minimum age. It reads the exemption only from the command it wraps, so ${input.confirm ? 'the step still waits; ' : ''}run it again as: ${rerun}`
                    : ageRefused ? `; the package manager's package-age filter refused ${spec}, a release that is too new: wait until it is older than the filter's minimum age, or exempt ${name} in your package manager's age-filter settings` : ''),
            fix: 'fix what the package manager reported (is the version published?), then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml> <version>' })
    }

    const node = await resolveExecutablePath(process.execPath)
    if (node.state !== 'available') return refused({ severity: 'error' as const, code: 'UPGRADE_SYNC_FAILED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_SYNC_FAILED,
        message: `${spec} is installed but the running Node could not be resolved: ${node.reason}`, fix: 'act on what sync reported above, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>' })
    const synced = await dependencies.executeForeground({ executable: node.value,
        argv: [join(root, 'node_modules', name, 'bin', 'cockpit.mjs'), ...syncArgv.slice(1)], cwd: root, env: input.env })
    if (synced.kind !== 'complete' || synced.exitCode !== 0) return refused({ severity: 'error' as const, code: 'UPGRADE_SYNC_FAILED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_SYNC_FAILED,
        message: `${spec} is installed but sync did not finish (${synced.kind === 'refusal' ? synced.code : `exit ${synced.exitCode}`}); the generated files are still those of ${installed}`,
        fix: 'act on what sync reported above, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>' }, synced.exitCode === 0 ? 1 : synced.exitCode)

    let upgradeSteps: string | string[]
    try {
        const notes = upgradeNotes(await readFile(join(root, 'node_modules', name, 'CHANGELOG.md'), 'utf8'), installed, target)
        upgradeSteps = notes.length === 0 ? 'the changelog lists no Upgrade: steps between these versions' : notes
    } catch (error) {
        upgradeSteps = `the installed package's CHANGELOG.md could not be read (${hasErrorCode(error, 'ENOENT') ? 'missing' : errorCause(error)}); release notes: ${npmPage(target)}`
    }

    // The files the upgrade wrote are those whose content differs from before it ran. One that already
    // held edits would carry them into the upgrade's commit, so it is named for review instead.
    const after = typeof before === 'string' ? before : await observeTree(root, input.env, dependencies.execute)
    const changed = typeof before === 'string' || typeof after === 'string' ? undefined
        : [...after.files].filter(([path, digest]) => before.files.get(path) !== digest).map(([path]) => path).sort()
    const held = changed?.filter(path => typeof before !== 'string' && before.files.has(path)) ?? []
    // The commit names its paths, so whatever else is staged stays out of it.
    const commitCommand = changed && `${formatShellCommand(['git', 'add', '--', ...changed])} && ${formatShellCommand(['git', 'commit', '-m', message, '--', ...changed])}`
    const checks = `run ${cockpitCommand('check', { config: configPath })}, then ${cockpitCommand('doctor', { config: configPath })}`
    // Safe Chain's wrapper prints its own summary once approve exits, which reads like a failure of the install.
    const safeChainNote = input.confirm && (await locateExecutable('safe-chain', input.env, root)).state === 'present'
        ? 'Safe Chain may print "Some package versions were suppressed" after this: that is its notice about other versions its age check hid; this install finished' : undefined
    const next = (committed: boolean) => [
        safeChainNote,
        committed ? undefined : branch && `${branch} (best run before the upgrade)`,
        committed ? `committed exactly the files the upgrade changed as "${message}": ${changed!.join(' ')}`
            : !changed ? 'review git diff, then commit package.json, the lockfile and the regenerated files together'
                : !changed.length ? 'the upgrade changed no file in the Git tree, so there is nothing to commit'
                    : `${held.length ? `review ${held.join(', ')} first, which held changes before the upgrade; then ` : ''}review git diff, then commit exactly the files the upgrade changed: ${commitCommand}`,
        checks,
    ].filter(Boolean).join('\n')
    const finished = { ...result, upgradeSteps }
    if (!input.commit) return { status: 0, diagnostics: [], result: { ...finished, next: next(false) } }

    const uncommitted = (reason: string): UpgradeOutcome => ({ status: 2, result: { ...finished, next: next(false) },
        diagnostics: [{ severity: 'error' as const, code: 'UPGRADE_COMMIT_FAILED' as const satisfies typeof ENVIRONMENT_CODES.UPGRADE_COMMIT_FAILED,
            message: `${spec} is installed and synced, but ${reason}`,
            fix: 'review the files the message names, then commit exactly the files the upgrade changed by path, as the next steps say' }] })
    if (typeof after === 'string') return uncommitted(`its Git state could not be read again (${after}), so nothing was committed`)
    if (!changed?.length) return uncommitted('it changed no file in the Git tree, so nothing was committed')
    if (held.length) return uncommitted(`${held.join(', ')} held changes before the upgrade, so nothing was committed`)
    // Anything else that wrote while the install ran would ride along, so the person at approve sees the
    // exact list before it is staged.
    if (input.confirm && !await input.confirm({ title: `Commit the upgrade to ${target} as "${message}"`,
        why: 'these files changed while the upgrade ran; one that something else changed meanwhile would be committed with it',
        details: changed })) return uncommitted('the person declined the commit, so nothing was committed')
    // Staged by explicit literal path, never by directory, glob or `-A`, and committed with the repository's own hooks.
    for (const [id, args] of [['upgrade:git-add', ['--literal-pathspecs', 'add', '--', ...changed]],
        ['upgrade:git-commit', ['--literal-pathspecs', 'commit', '-m', message, '--', ...changed]]] as const) {
        const write = step(after.git, root, input.env, id, args, INSTALL_TIMEOUT_MS)
        const outcome = authenticatedExecutionOutcome(await dependencies.execute(write), write)
        if (outcome?.kind !== 'complete') {
            const output = outcome ? `${outcome.stdout.toString('utf8')}\n${outcome.stderr.toString('utf8')}`.trim().split('\n').slice(-4).join(' | ').slice(0, 512) : 'the outcome could not be authenticated'
            return uncommitted(`git ${args[1]} failed (${output})${id === 'upgrade:git-commit' ? `; ${changed.join(', ')} ${changed.length === 1 ? 'stays' : 'stay'} staged` : ''}`)
        }
    }
    return { status: 0, diagnostics: [], result: { ...finished, committed: changed, next: next(true) } }
}
