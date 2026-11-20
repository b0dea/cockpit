/**
 * Owns `cockpit guard prove`: drive the standard probe matrix and the cockpit's declared cases through
 * the hook commands sync generated, in each harness's PreToolUse shape, and read each answer back.
 *
 * It proves the generated hooks rather than the evaluator: a person re-proving the guard by hand after
 * every upgrade piped each payload into both hook commands. The run happens in a scratch clone synced
 * for this machine, because the checkout's state changes answers: dirty guard controls change what
 * `git stash` or `reset` may write, and a branch's upstream decides where a bare `git push` goes. Where
 * no scratch clone can be made valid, it runs in place and records the checkout state beside the
 * answers instead.
 *
 * Every child process crosses the supplied `execute`, bound to environment-exec/execute.ts.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { readBoundedFile } from '../../bounded-read.js'
import { formatShellCommand } from '../../fix-catalogue.js'
import { loadCockpitConfig } from '../../config/load.js'
import { authenticatedExecutionOutcome, failedStepStderr, type ExecuteProbeOutcome } from '../../environment-exec/execute.js'
import { standardProbes, type ProveExpectation, type ProveProbe } from '../../guards/prove-matrix.js'
import { GUARD_LOCAL_PATHS, writeCockpitLocalFiles } from '../../guards/local-identity.js'
import { installedPackageMetadata } from '../../package-metadata.js'
import type { CockpitConfig } from '../../schema.js'
import { ENVIRONMENT_CODES, errorCause, parseJsonText, tryParseJson, type EnvironmentDiagnostic, type ExecutionStep } from '../contract.js'
import { guardProtectedLocations, isSensitiveGuardName } from '../../guards/evaluator.js'
import { confinedPath } from './shared.js'
import { resolveExecutable, resolveExecutablePath, type ResolvedExecutable } from '../executable.js'
import { createGitRunner, type GitRunner } from '../sibling-checkouts.js'
import { mapLimit } from '../map-limit.js'

type Execute = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
type Harness = 'claudecode' | 'codexcli'

export interface GuardProveInput {
    readonly configPath: string
    /** A case file that replaces `[guards] cases` for this run, resolved by the caller. */
    readonly casesPath?: string
    readonly realSessions: boolean
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface GuardProveOutcome {
    readonly status: number
    readonly result: unknown
    readonly diagnostics: readonly EnvironmentDiagnostic[]
    readonly artifact?: string | null
}

const REPORT_FORMAT = 'cockpit-guard-prove/v1'
const REPORT_DIRECTORY = `${GUARD_LOCAL_PATHS.directory}/guard-prove`
const SCRATCH_BRANCH = 'cockpit-guard-prove'
// The harnesses whose guard is a hook command a harness runs with the call on stdin.
const REGISTRATIONS: Readonly<Record<Harness, readonly string[]>> = {
    claudecode: ['.claude/settings.json', '.claude/settings.local.json'],
    codexcli: ['.codex/hooks.json'],
}
const HOOK_TIMEOUT_MS = 60_000
const SYNC_TIMEOUT_MS = 300_000
// Each hook run starts Node and several Git processes; machines are shared by several agent sessions.
const CONCURRENCY = Math.min(4, availableParallelism())
const CASE_FILE_MAX_BYTES = 8_388_608
const REGISTRATION_MAX_BYTES = 1_048_576
const DECODER = new TextDecoder('utf-8', { fatal: false })

const ProveCase = z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'an id is letters, digits, ".", "_", ":" or "-", up to 128 characters'),
    command: z.string().min(1, 'a command is not empty').max(65_536),
    cwd: z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
    expect: z.enum(['allow', 'refuse', 'ask']).optional(),
}).strict()
const ProveCases = z.array(ProveCase, 'the file holds a list of cases').max(20_000).superRefine((cases, ctx) => {
    const seen = new Set<string>()
    for (const [index, row] of cases.entries()) {
        if (seen.has(row.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'an earlier entry has the same id' })
        seen.add(row.id)
    }
})
type ProveCase = z.infer<typeof ProveCase>

/**
 * One answer the hook gave, by how strongly it holds the call when several hooks answer: `none` is a
 * hook that exited 0 without an answer, so the call runs.
 */
const SEVERITY = { none: 0, allow: 1, ask: 2, deny: 3, refused: 3, error: 4 } as const
type Decision = keyof typeof SEVERITY
const DECISIONS = Object.keys(SEVERITY) as readonly Decision[]
const ALLOWED: readonly Decision[] = ['allow', 'none']

type Row = Omit<ProveProbe, 'expect' | 'rule'> & Readonly<{
    source: 'standard' | 'cases'
    /** Relative to the cockpit root, as the case file spells it. */
    cwd: string
    expect?: ProveExpectation
    rule?: string
}>

interface Answer extends Row {
    readonly harness: Harness
    readonly decision: Decision
    readonly reason: string
    readonly matches: boolean | null
    regression: boolean
    previous?: Decision
}

interface Report {
    readonly format: typeof REPORT_FORMAT
    readonly cockpitVersion: string
    readonly provedAt: string
    readonly config: string
    readonly checkout: Checkout
    readonly harnesses: readonly HarnessHooks[]
    readonly skipped: readonly Readonly<{ harness: string; reason: string }>[]
    /** Failed when any answer failed or the run could not prove a listed harness; doctor reads it. */
    readonly status: 'passed' | 'failed'
    /** The run's own errors, such as a harness with no hook, which leave no answer row behind. */
    readonly errors: readonly Readonly<{ code: string; message: string; target?: string }>[]
    readonly results: readonly Answer[]
}

type Checkout = Readonly<{ mode: 'scratch'; commit: string; branch: typeof SCRATCH_BRANCH; upstream: null
    /** What the clone committed over the checkout's commit: the working cockpit.toml and what sync wrote from it. */
    committedInClone: readonly string[]; source: CheckoutState }>
    | Readonly<{ mode: 'in-place'; reason: string } & CheckoutState>
type CheckoutState = Readonly<{ branch: string | null; upstream: string | null; dirty: readonly string[] }>

interface HarnessHooks {
    readonly harness: Harness
    readonly registrations: readonly string[]
    readonly hooks: readonly Readonly<{ matcher?: string; command: string }>[]
    /** The harness turns an ask into a refusal, so `ask` and `refuse` expectations both mean not allowed. */
    readonly foldsAsk: boolean
}

/** Where the hooks run: the cockpit root they guard, the home holding the machine's guard check, and how paths map there. */
interface RunPlace {
    readonly root: string
    readonly home: string
    readonly payloads: string
    readonly checkout: Checkout
    /** The path where the hooks run for a path in the checkout; undefined outside the cockpit and its siblings. */
    readonly map: (path: string) => string | undefined
    readonly cleanup: () => Promise<void>
}

class ScratchUnavailable extends Error {}

const refused = (code: EnvironmentDiagnostic['code'], message: string, target?: string, fix?: string): GuardProveOutcome => ({
    status: 2, result: null, artifact: null,
    diagnostics: [{ severity: 'error', code, message, ...target === undefined ? {} : { target }, ...fix === undefined ? {} : { fix } }],
})

/**
 * Why a case file may not be read, or undefined. `[guards] cases` widens nothing, so an agent may set
 * it unapproved; it must not become a way to read a secret back through the refusal that quotes it.
 */
function casePathRefusal(root: string, path: string, config: CockpitConfig, configPath: string): string | undefined {
    if (!path.endsWith('.json')) return `${path} is not a .json file`
    let real: string
    try { real = existsSync(path) ? realpathSync(path) : path }
    catch (error) { return `${path} could not be resolved (${errorCause(error)})` }
    if (!confinedPath(root, path) || !confinedPath(root, real)) return `${path} lies outside the cockpit ${root}`
    const inside = (candidate: string) => relative(root, candidate).split(sep)
    if ([...inside(path), ...inside(real)].some(isSensitiveGuardName)) return `${path} is under a name the guard keeps secret`
    const protectedPaths = [...guardProtectedLocations({ canonicalRoot: root, configPath, instances: [] }).map(row => row.path),
        ...config.guards.secret_paths.filter(entry => !entry.includes(':')).map(entry => join(root, entry))]
    if (protectedPaths.some(location => [path, real].some(candidate => candidate === location || confinedPath(location, candidate)))) {
        return `${path} is a location the guard protects`
    }
    return undefined
}

function readCases(path: string): readonly ProveCase[] | string {
    let bytes: Buffer
    try {
        const read = readBoundedFile(path, CASE_FILE_MAX_BYTES)
        if (read.kind !== 'complete') return `${path} is larger than ${CASE_FILE_MAX_BYTES} bytes`
        bytes = read.bytes
    } catch (error) { return `${path} could not be read (${errorCause(error)})` }
    const json = parseJsonText(bytes.toString('utf8'), path, 'a JSON list of cases')
    if ('refusal' in json) return json.refusal
    const value = json.value
    const parsed = ProveCases.safeParse(value)
    if (parsed.success) return parsed.data
    return `${path}: ${parsed.error.issues.slice(0, 5).map(issue => `${issue.path.length === 0 ? 'the file' : `entry ${issue.path.join('.')}`}: ${issue.message}`).join('; ')}`
}

/** The deepest directory holding every path. */
function commonAncestor(paths: readonly string[]): string {
    const parts = paths.map(path => path.split(sep))
    const shared: string[] = []
    for (let index = 0; parts.every(path => index < path.length && path[index] === parts[0]![index]); index++) shared.push(parts[0]![index]!)
    return shared.join(sep) || sep
}

async function gitText(git: GitRunner, cwd: string, id: string, args: readonly string[]): Promise<string | undefined> {
    const run = await git.run(cwd, id, args)
    return run.kind === 'complete' ? run.stdout : undefined
}

async function checkoutState(git: GitRunner, root: string): Promise<CheckoutState> {
    const branch = await gitText(git, root, 'guard-prove:branch', ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const upstream = await gitText(git, root, 'guard-prove:upstream', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    const status = await gitText(git, root, 'guard-prove:status', ['status', '--porcelain', '--untracked-files=all'])
    return { branch: branch || null, upstream: upstream || null,
        dirty: (status ?? '').split('\n').filter(Boolean).slice(0, 200).map(line => line.slice(3)) }
}

function packageRoot(): string {
    // This module runs from dist/environment/application, so three levels up is the running package.
    return realpathSync(fileURLToPath(new URL('../../../', import.meta.url)))
}

function step(executable: ResolvedExecutable, argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, id: string, timeoutMs: number): ExecutionStep {
    return {
        id, argv: [executable.canonicalPath, ...argv], argv0: executable.invocationPath, cwd, env, timeoutMs,
        stdoutLimitBytes: 262_144, stderrLimitBytes: 65_536, outputOverflow: 'retain-tail', failureOutput: 'stderr-tail',
        paths: [], ports: [], labels: { purpose: id }, expected: [],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
            argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
        filesystemChecks: [], compensation: [],
    }
}

/**
 * A clean clone of the cockpit's repository and of each sibling's, laid out as on disk, on a branch
 * with no upstream, and synced by this cockpit for a home of its own. The installed packages are
 * linked in, so the guard protects the same installed code it protects in the checkout.
 */
async function prepareScratch(root: string, configPath: string, config: CockpitConfig, git: GitRunner,
    env: Readonly<Record<string, string | undefined>>, execute: Execute): Promise<RunPlace> {
    const scratch = realpathSync(await mkdtemp(join(tmpdir(), 'cockpit-guard-prove-')))
    const cleanup = () => rm(scratch, { recursive: true, force: true })
    try {
        const toplevel = async (path: string, what: string) => {
            if (!existsSync(path)) throw new ScratchUnavailable(`${what} ${path} does not exist`)
            const top = await gitText(git, path, 'guard-prove:toplevel', ['rev-parse', '--show-toplevel'])
            if (!top) throw new ScratchUnavailable(`${what} ${path} is not in a Git repository`)
            if (await gitText(git, top, 'guard-prove:head', ['rev-parse', '--verify', '--quiet', 'HEAD']) === undefined) {
                throw new ScratchUnavailable(`the repository at ${top} has no commit to clone`)
            }
            return realpathSync(top)
        }
        const siblings = config.sibling.map(row => resolve(root, config.cockpit.siblings_root, row.dir))
        const repositories = [...new Set([await toplevel(root, 'the cockpit'),
            ...await mapLimit(siblings, CONCURRENCY, path => toplevel(path, 'the sibling'))])].sort((a, b) => a.length - b.length)
        const base = commonAncestor([...repositories, root, ...siblings.map(path => realpathSync(path))])
        const tree = join(scratch, 'tree')
        const home = join(scratch, 'home')
        await mkdir(tree, { recursive: true })
        await mkdir(home, { recursive: true })
        const map = (path: string) => relative(base, path).startsWith('..') ? undefined : join(tree, relative(base, path))
        for (const repository of repositories) {
            const target = map(repository)!
            if (target !== tree) await mkdir(dirname(target), { recursive: true })
            const clone = await git.run(tree, 'guard-prove:clone', ['clone', '--quiet', '--local', repository, target])
            if (clone.kind !== 'complete') throw new ScratchUnavailable(`git clone of ${repository} failed (${clone.detail})`)
            const branch = await git.run(target, 'guard-prove:branch-create', ['checkout', '--quiet', '-B', SCRATCH_BRANCH])
            if (branch.kind !== 'complete') throw new ScratchUnavailable(`git checkout in the clone of ${repository} failed (${branch.detail})`)
        }
        const scratchRoot = map(root)!
        // The guard in force was synced from the working cockpit.toml, committed or not, so that is the
        // policy the clone is synced from.
        const scratchConfig = join(scratchRoot, basename(configPath))
        await copyFile(configPath, scratchConfig)
        const installed = join(root, 'node_modules')
        if (existsSync(installed)) {
            await symlink(realpathSync(installed), join(scratchRoot, 'node_modules'))
            const top = repositories.filter(path => root === path || root.startsWith(`${path}${sep}`)).at(-1)!
            const exclude = join(map(top)!, '.git', 'info', 'exclude')
            await mkdir(dirname(exclude), { recursive: true })
            await appendFile(exclude, `\n/${relative(top, join(root, 'node_modules')).split(sep).join('/')}\n`)
        }
        const node = await resolveExecutablePath(process.execPath)
        if (node.state !== 'available') throw new ScratchUnavailable(`the running Node could not be resolved: ${node.reason}`)
        const syncStep = step(node.value, [join(packageRoot(), 'bin', 'cockpit.mjs'), 'sync', '--config', scratchConfig], scratchRoot,
            { PATH: env.PATH ?? '', HOME: home }, 'guard-prove:sync', SYNC_TIMEOUT_MS)
        const synced = authenticatedExecutionOutcome(await execute(syncStep), syncStep)
        if (synced?.kind !== 'complete') {
            throw new ScratchUnavailable(`sync in the scratch clone did not finish (${synced === undefined ? 'unauthenticated outcome'
                : `${synced.code}${failedStepStderr(synced.stderr) ? `: ${failedStepStderr(synced.stderr)}` : ''}`})`)
        }
        // A working cockpit.toml, and the files sync regenerated from it, would leave guard controls dirty,
        // and a dirty control changes what a stash or reset may write; committing them in the clone keeps
        // its tree clean.
        const changed = (await checkoutState(git, scratchRoot)).dirty
        if (changed.length > 0) {
            const commitArgs = ['-c', 'user.name=cockpit guard prove', '-c', 'user.email=guard-prove@cockpit.invalid']
            for (const args of [['add', '--all'], [...commitArgs, 'commit', '--quiet', '--no-gpg-sign', '-m', 'guard prove: working cockpit.toml and its sync']]) {
                const run = await git.run(scratchRoot, 'guard-prove:commit-sync', args)
                if (run.kind !== 'complete') throw new ScratchUnavailable(`committing the sync in the scratch clone failed (${run.detail})`)
            }
        }
        const commit = await gitText(git, scratchRoot, 'guard-prove:commit', ['rev-parse', 'HEAD'])
        return { root: scratchRoot, home, payloads: join(scratch, 'payloads'), map, cleanup,
            checkout: { mode: 'scratch', commit: commit ?? 'unknown', branch: SCRATCH_BRANCH, upstream: null, committedInClone: changed, source: await checkoutState(git, root) } }
    } catch (error) {
        await cleanup()
        throw error
    }
}

async function readHooks(runRoot: string, harness: Harness, config: CockpitConfig): Promise<HarnessHooks | string> {
    const registrations: string[] = []
    const hooks: { matcher?: string; command: string }[] = []
    for (const path of REGISTRATIONS[harness]) {
        const file = join(runRoot, path)
        if (!existsSync(file)) continue
        let read: ReturnType<typeof readBoundedFile>
        try { read = readBoundedFile(file, REGISTRATION_MAX_BYTES) }
        catch (error) { return `${path} could not be read (${errorCause(error)})` }
        if (read.kind !== 'complete') return `${path} is larger than ${REGISTRATION_MAX_BYTES} bytes`
        const json = parseJsonText(read.bytes.toString('utf8'), path, 'agent tool settings')
        if ('refusal' in json) return json.refusal
        const entries = (json.value as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse
        if (entries === undefined) continue
        if (!Array.isArray(entries)) return `${path} hooks.PreToolUse is not a list`
        registrations.push(path)
        for (const entry of entries as { matcher?: unknown; hooks?: unknown }[]) {
            for (const hook of Array.isArray(entry?.hooks) ? entry.hooks as { command?: unknown }[] : []) {
                if (typeof hook?.command !== 'string') continue
                const matcher = typeof entry.matcher === 'string' ? entry.matcher : undefined
                // Claude Code runs an identical command once, and the local registration repeats the committed one.
                if (!hooks.some(seen => seen.command === hook.command && seen.matcher === matcher)) hooks.push({ ...matcher === undefined ? {} : { matcher }, command: hook.command })
            }
        }
    }
    if (hooks.length === 0) return `no PreToolUse hook command in ${REGISTRATIONS[harness].join(' or ')}`
    return { harness, registrations, hooks, foldsAsk: harness !== 'claudecode' || config.guards.unresolved === 'deny' }
}

function hookMatches(matcher: string | undefined, tool: string): boolean {
    if (matcher === undefined || matcher === '' || matcher === '*') return true
    try { return new RegExp(matcher).test(tool) }
    catch { return matcher.split('|').includes(tool) } // a matcher that is no regular expression is a list of names
}


/** One hook command's answer to one payload, read as its harness reads it. */
function readAnswer(outcome: ExecuteProbeOutcome | undefined): Readonly<{ decision: Decision; reason: string }> {
    if (outcome === undefined) return { decision: 'error', reason: 'the hook outcome could not be authenticated' }
    const text = (bytes: Buffer) => DECODER.decode(bytes).trim()
    if (outcome.kind === 'refusal') {
        const stderr = text(outcome.stderr).slice(0, 2048)
        if (outcome.execution.exitCode === 2 && outcome.execution.signal === null) return { decision: 'refused', reason: stderr || 'exit 2 without a reason' }
        return { decision: 'error', reason: `${outcome.code} (exit ${outcome.execution.exitCode})${stderr ? `: ${stderr}` : ''}` }
    }
    const stdout = text(outcome.stdout)
    if (stdout === '') return { decision: 'none', reason: 'the hook exited 0 without an answer, so the call runs' }
    const output = (tryParseJson(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown } } | undefined)?.hookSpecificOutput
    const decision = output?.permissionDecision
    if (decision === 'allow' || decision === 'ask' || decision === 'deny') {
        return { decision, reason: typeof output?.permissionDecisionReason === 'string' ? output.permissionDecisionReason : '' }
    }
    return { decision: 'error', reason: `the hook printed an answer no harness reads: ${stdout.slice(0, 512)}` }
}

function matches(expect: ProveExpectation | undefined, decision: Decision, foldsAsk: boolean): boolean | null {
    if (expect === undefined) return decision === 'error' ? false : null
    if (expect === 'allow') return ALLOWED.includes(decision)
    if (expect === 'refuse') return decision === 'deny' || decision === 'refused'
    return decision === 'ask' || foldsAsk && (decision === 'deny' || decision === 'refused')
}

/** The report the bytes hold, checked row by row, or undefined when they are not one. */
function parseReport(text: string): Report | undefined {
    const value = tryParseJson(text) as Partial<Report> | undefined
    const row = (item: unknown) => {
        const answer = item as Partial<Answer> | null
        return answer !== null && typeof answer === 'object' && (['source', 'id', 'harness', 'tool', 'command', 'cwd'] as const).every(key => typeof answer[key] === 'string')
            && DECISIONS.includes(answer.decision as Decision) && typeof answer.regression === 'boolean' && (answer.matches === null || typeof answer.matches === 'boolean')
    }
    return value !== null && typeof value === 'object' && value.format === REPORT_FORMAT && typeof value.cockpitVersion === 'string'
        && typeof value.provedAt === 'string' && (value.status === 'passed' || value.status === 'failed') && Array.isArray(value.errors)
        && Array.isArray(value.results) && value.results.every(row) ? value as Report : undefined
}

/**
 * The newest report another cockpit version wrote, and the files that could not be read as one. The
 * installed version's own report is the one this run replaces: comparing with it would clear a
 * regression on the second run.
 */
async function previousReport(directory: string): Promise<Readonly<{ path?: string; report?: Report; unreadable: readonly string[] }>> {
    if (!existsSync(directory)) return { unreadable: [] }
    let newest: { path: string; report: Report } | undefined
    const unreadable: string[] = []
    const own = `${installedPackageMetadata.version}.json`
    for (const name of readdirSync(directory).filter(name => name.endsWith('.json') && name !== own).sort()) {
        const path = join(directory, name)
        const report = parseReport(await readFile(path, 'utf8'))
        if (report === undefined) unreadable.push(path)
        else if (report.cockpitVersion !== installedPackageMetadata.version && (!newest || report.provedAt > newest.report.provedAt)) newest = { path, report }
    }
    return { ...newest, unreadable }
}

function reportPath(root: string): string {
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(installedPackageMetadata.version)) throw new Error(`the cockpit version ${installedPackageMetadata.version} cannot name a report file`)
    return join(root, REPORT_DIRECTORY, `${installedPackageMetadata.version}.json`)
}

async function writeReport(root: string, path: string, report: Report): Promise<void> {
    const local = await writeCockpitLocalFiles(root, [])
    if (local.kind !== 'complete') throw new Error(`the guard prove report could not be written: ${local.message}`)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
}

/** The headless sessions that would send each probe through a real agent tool, named and never started. */
async function realSessionsPlan(root: string, rows: readonly Row[], env: Readonly<Record<string, string | undefined>>) {
    const prompt = (command: string) => `Run this exact shell command once with your shell tool, then say only whether it ran or was refused: ${command}`
    const claude = (command: string) => ['claude', '-p', '--output-format', 'json', prompt(command)]
    const codex = (cwd: string, command: string) => ['codex', 'exec', '--json', '-C', cwd, prompt(command)]
    const installed = async (name: string) => (await resolveExecutable(name, env)).state === 'available'
    return {
        run: false,
        reason: 'Each session is a paid model call that needs the person\'s own login; the model decides whether and how it makes the call, so its answer is not a repeatable reading of the guard; and a session runs any call the guard lets through, so a probe the guard wrongly allowed would read a secret or push for real. The hook answers in this report come from the same hook commands those sessions would run.',
        installed: { claude: await installed('claude'), codex: await installed('codex') },
        sessions: rows.filter(row => row.tool === 'Bash').length,
        commands: [formatShellCommand(claude('<command>')), formatShellCommand(codex(root, '<command>'))],
        runs: rows.filter(row => row.tool === 'Bash').flatMap(row => [
            { harness: 'claudecode', id: row.id, cwd: resolve(root, row.cwd), argv: claude(row.command) },
            { harness: 'codexcli', id: row.id, cwd: root, argv: codex(resolve(root, row.cwd), row.command) },
        ]),
    }
}

export async function runGuardProve(input: GuardProveInput, dependencies: Readonly<{ execute: Execute }>): Promise<GuardProveOutcome> {
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return { status: loaded.status, result: null, diagnostics: loaded.diagnostics }
    const { config, source } = loaded.result
    // Real paths throughout, so the checkout, its siblings and their clones compare as Git names them.
    const root = realpathSync(dirname(source.path))
    const casesPath = input.casesPath ?? (config.guards.cases === undefined ? undefined : resolve(root, config.guards.cases))
    const cases = casesPath === undefined ? [] : casePathRefusal(root, casesPath, config, source.path) ?? readCases(casesPath)
    if (typeof cases === 'string') {
        return refused('GUARD_PROVE_CASES_INVALID' satisfies typeof ENVIRONMENT_CODES.GUARD_PROVE_CASES_INVALID, cases, casesPath,
            'write the case file as a JSON list of {"id", "command", "cwd"?, "expect"?} entries, with expect one of allow, refuse or ask, then rerun ./node_modules/@b00dea/cockpit/bin/cockpit.mjs guard prove --config <your cockpit.toml>')
    }
    const harnesses = config.surfaces.tools.filter((tool): tool is Harness => tool === 'claudecode' || tool === 'codexcli')
    const skipped = config.surfaces.tools.filter(tool => tool === 'opencode')
        .map(harness => ({ harness, reason: 'OpenCode runs the guard from a plugin inside its own process, so there is no hook command to drive' }))
    if (harnesses.length === 0) {
        return refused('GUARD_PROVE_HOOK_UNAVAILABLE' satisfies typeof ENVIRONMENT_CODES.GUARD_PROVE_HOOK_UNAVAILABLE,
            '[surfaces] tools lists neither claudecode nor codexcli, whose guards are the hook commands guard prove drives', 'surfaces.tools')
    }
    const git = await createGitRunner(input.env, dependencies.execute)
    if ('unavailable' in git) return refused(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, `guard prove clones and reads the checkout with Git, which is unavailable: ${git.unavailable}`, 'git')
    const shell = await resolveExecutablePath('/bin/sh')
    if (shell.state !== 'available') return refused(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, `guard prove runs hook commands with /bin/sh, which is unavailable: ${shell.reason}`, '/bin/sh')

    const diagnostics: EnvironmentDiagnostic[] = []
    let place: RunPlace
    try {
        place = await prepareScratch(root, source.path, config, git, input.env, dependencies.execute)
    } catch (error) {
        if (!(error instanceof ScratchUnavailable)) throw error
        const payloads = realpathSync(await mkdtemp(join(tmpdir(), 'cockpit-guard-prove-')))
        place = { root, home: input.env.HOME ?? '', payloads, map: path => path, cleanup: () => rm(payloads, { recursive: true, force: true }),
            checkout: { mode: 'in-place', reason: error.message, ...await checkoutState(git, root) } }
        diagnostics.push({ severity: 'warning', code: 'GUARD_PROVE_IN_PLACE' satisfies typeof ENVIRONMENT_CODES.GUARD_PROVE_IN_PLACE,
            message: `no scratch clone could be made valid for the guard (${error.message}), so the hooks ran in this checkout, whose branch, upstream and uncommitted files can change answers; the report records them`,
            target: root })
    }
    try {
        await mkdir(place.payloads, { recursive: true })
        const hooks: HarnessHooks[] = []
        for (const harness of harnesses) {
            const read = await readHooks(place.root, harness, config)
            if (typeof read === 'string') {
                diagnostics.push({ severity: 'error', code: 'GUARD_PROVE_HOOK_UNAVAILABLE' satisfies typeof ENVIRONMENT_CODES.GUARD_PROVE_HOOK_UNAVAILABLE,
                    message: `${harness} is listed in [surfaces] tools but its guard hook could not be found: ${read}`, target: harness,
                    fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>, commit the generated files, then rerun guard prove' })
            } else hooks.push(read)
        }
        const rows: Row[] = [
            ...standardProbes(config.guards, packageRoot())
                .map((probe): Row => ({ ...probe, source: 'standard', cwd: '.' })),
            ...cases.map((row): Row => ({ source: 'cases', id: row.id, tool: 'Bash', command: row.command, cwd: row.cwd ?? '.',
                ...row.expect === undefined ? {} : { expect: row.expect } })),
        ]
        const runEnvironment = (harness: Harness): Record<string, string> => ({ PATH: input.env.PATH ?? '', HOME: place.home,
            ...harness === 'claudecode' ? { CLAUDE_PROJECT_DIR: place.root } : {} })
        // A row's payload is the same for every harness, and most rows share a working directory.
        const directories = new Map<string, Readonly<{ cwd: string } | { error: string }>>()
        const directory = (cwd: string) => {
            const known = directories.get(cwd)
            if (known) return known
            const mapped = place.map(resolve(root, cwd))
            const found = mapped === undefined ? { error: `the working directory ${cwd} lies outside the cockpit and its siblings` }
                : !existsSync(mapped) || !lstatSync(mapped).isDirectory() ? { error: `the working directory ${cwd} does not exist where the hooks run` }
                : { cwd: realpathSync(mapped) }
            directories.set(cwd, found)
            return found
        }
        const payloads = await mapLimit(rows, CONCURRENCY, async row => {
            const found = directory(row.cwd)
            if ('error' in found) return found
            const toolInput = row.tool === 'Bash' ? { command: row.command } : { file_path: isAbsolute(row.command) ? row.command : join(found.cwd, row.command), content: 'guard prove\n' }
            const path = join(place.payloads, `${createHash('sha256').update(`${row.source}\0${row.id}`).digest('hex')}.json`)
            await writeFile(path, JSON.stringify({ session_id: 'cockpit-guard-prove', hook_event_name: 'PreToolUse', tool_name: row.tool, cwd: found.cwd, tool_input: toolInput }))
            return { path }
        })
        const work = hooks.flatMap(harnessHooks => {
            const byTool = { Bash: harnessHooks.hooks.filter(hook => hookMatches(hook.matcher, 'Bash')), Write: harnessHooks.hooks.filter(hook => hookMatches(hook.matcher, 'Write')) }
            return rows.map((row, index) => ({ harnessHooks, row, payload: payloads[index]!, applicable: byTool[row.tool] }))
        })
        const answers = await mapLimit(work, CONCURRENCY, async ({ harnessHooks, row, payload, applicable }): Promise<Answer> => {
            const { harness, foldsAsk } = harnessHooks
            const answer = (decision: Decision, reason: string): Answer => ({ ...row, harness, decision, reason, matches: matches(row.expect, decision, foldsAsk), regression: false })
            if ('error' in payload) return answer('error', payload.error)
            const payloadPath = payload.path
            if (applicable.length === 0) return answer('none', `no PreToolUse hook matches ${row.tool}`)
            let combined = { decision: 'none' as Decision, reason: '' }
            for (const hook of applicable) {
                // The executor gives a child no input, so the shell takes the payload file as its stdin
                // before it runs the hook command exactly as the harness would.
                const hookStep = step(shell.value, ['-c', 'exec <"$0" && eval "$1"', payloadPath, hook.command], place.root,
                    runEnvironment(harness), `guard-prove:${harness}:${row.id}`, HOOK_TIMEOUT_MS)
                const read = readAnswer(authenticatedExecutionOutcome(await dependencies.execute(hookStep), hookStep))
                if (SEVERITY[read.decision] >= SEVERITY[combined.decision]) combined = read
            }
            return answer(combined.decision, combined.reason)
        })

        const path = reportPath(root)
        const previous = await previousReport(dirname(path))
        const key = (row: Answer) => JSON.stringify([row.source, row.id, row.harness, row.tool, row.command, row.cwd])
        const before = new Map((previous.report?.results ?? []).map(row => [key(row), row.decision]))
        for (const row of answers) {
            const was = before.get(key(row))
            if (was === undefined) continue
            row.previous = was
            row.regression = ALLOWED.includes(row.decision) && (was === 'ask' || was === 'deny' || was === 'refused')
        }
        const runErrors = diagnostics.filter(row => row.severity === 'error').map(({ code, message, target }) => ({ code, message, ...target === undefined ? {} : { target } }))
        const mismatches = answers.filter(row => row.matches === false)
        const regressions = answers.filter(row => row.regression)
        const describe = (row: Answer) => `\`${row.command}\`${row.cwd === '.' ? '' : ` in ${row.cwd}`}`
        for (const row of mismatches) {
            diagnostics.push({ severity: 'error', code: 'GUARD_PROVE_MISMATCH' satisfies typeof ENVIRONMENT_CODES.GUARD_PROVE_MISMATCH,
                message: `${describe(row)} expected ${row.expect ?? 'an answer'}, got ${row.decision}${row.rule ? ` (${row.rule})` : ''}: ${row.reason}`,
                target: `${row.harness}:${row.id}` })
        }
        for (const row of regressions) {
            diagnostics.push({ severity: 'error', code: 'GUARD_PROVE_REGRESSION' satisfies typeof ENVIRONMENT_CODES.GUARD_PROVE_REGRESSION,
                message: `${describe(row)} is allowed now (${row.decision}) and was ${row.previous} in ${previous.path}`, target: `${row.harness}:${row.id}` })
        }
        for (const unreadable of previous.unreadable) {
            diagnostics.push({ severity: 'warning', code: 'GUARD_PROVE_PREVIOUS_UNREADABLE' satisfies typeof ENVIRONMENT_CODES.GUARD_PROVE_PREVIOUS_UNREADABLE,
                message: `${unreadable} is not a guard prove report this version can read, so no case was compared with it; a regression since that run would go unflagged`,
                target: unreadable })
        }
        const failed = diagnostics.some(row => row.severity === 'error')
        const report: Report = { format: REPORT_FORMAT, cockpitVersion: installedPackageMetadata.version, provedAt: new Date().toISOString(),
            config: source.path, checkout: place.checkout, harnesses: hooks, skipped, status: failed ? 'failed' : 'passed',
            errors: runErrors,
            results: answers }
        await writeReport(root, path, report)

        const realSessions = input.realSessions ? await realSessionsPlan(root, rows, input.env) : undefined
        const where = place.checkout.mode === 'scratch' ? `a scratch clone of ${place.checkout.commit.slice(0, 12)}` : `this checkout (${place.checkout.reason})`
        const lines = [
            `Guard prove: ${answers.length} answers from ${hooks.map(row => row.harness).join(', ') || 'no harness'} in ${where}; ${mismatches.length} ${mismatches.length === 1 ? 'mismatch' : 'mismatches'}, ${regressions.length} ${regressions.length === 1 ? 'regression' : 'regressions'}.`,
            ...skipped.map(row => `Not proved: ${row.harness}: ${row.reason}.`),
            `Report: ${path}`,
            previous.path ? `Compared with: ${previous.path}` : 'Compared with: no earlier report.',
            ...realSessions === undefined ? [] : [`Real sessions: not run. ${realSessions.reason} Would run, once per shell probe and case (${realSessions.sessions}), from ${root}, with <command> replaced by it (--json lists each):`,
                ...(['claude', 'codex'] as const).map((name, index) =>
                    `  ${realSessions.commands[index]} (${name} is ${realSessions.installed[name] ? 'on PATH' : 'not on PATH'})`)],
        ]
        return {
            status: failed ? 2 : 0, diagnostics, artifact: `${lines.join('\n')}\n`,
            result: { report: path, cockpitVersion: installedPackageMetadata.version, checkout: place.checkout, harnesses: hooks, skipped,
                answers: answers.length, mismatches, regressions, previous: previous.path ?? null, unreadablePrevious: previous.unreadable,
                ...realSessions === undefined ? {} : { realSessions } },
        }
    } finally {
        await place.cleanup()
    }
}

/**
 * Doctor's view of the proof: a cockpit that declares cases and has no report for the installed
 * version has not re-proved its guard since it last changed, and one whose report failed says so.
 */
export async function guardProveDoctorDiagnostics(root: string, config: CockpitConfig): Promise<readonly EnvironmentDiagnostic[]> {
    if (config.guards.cases === undefined) return []
    const path = reportPath(realpathSync(root))
    if (!existsSync(path)) {
        return [{ severity: 'warning', code: 'GUARD_PROVE_REPORT_MISSING' satisfies typeof ENVIRONMENT_CODES.GUARD_PROVE_REPORT_MISSING,
            message: `cockpit.toml declares guard cases, and no guard prove report exists for the installed cockpit ${installedPackageMetadata.version}, so the guard's answers have not been proved since it was installed`,
            target: 'guards.cases', fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs guard prove --config <your cockpit.toml>' }]
    }
    const failing = (message: string): readonly EnvironmentDiagnostic[] => [{ severity: 'warning',
        code: 'GUARD_PROVE_REPORT_FAILING' satisfies typeof ENVIRONMENT_CODES.GUARD_PROVE_REPORT_FAILING, message, target: 'guards.cases',
        fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs guard prove --config <your cockpit.toml> and act on each mismatch, regression and error it lists' }]
    let text: string
    try { text = await readFile(path, 'utf8') }
    catch (error) { return failing(`the guard prove report ${path} could not be read (${errorCause(error)}), so the guard's answers are unproved`) }
    const report = parseReport(text)
    // Fail closed: a report this version cannot read, or one another version wrote, proves nothing.
    if (report === undefined || report.cockpitVersion !== installedPackageMetadata.version) {
        return failing(`${path} is not a guard prove report of the installed cockpit ${installedPackageMetadata.version}, so the guard's answers are unproved`)
    }
    if (report.status === 'passed') return []
    const answers = report.results.filter(row => row.matches === false || row.regression).length
    return failing(`the last guard prove for ${installedPackageMetadata.version} failed: ${answers} ${answers === 1 ? 'answer differs' : 'answers differ'} from an expectation or ${answers === 1 ? 'was' : 'were'} refused before, and ${report.errors.length} ${report.errors.length === 1 ? 'error' : 'errors'} stopped part of the run: ${path}`)
}
