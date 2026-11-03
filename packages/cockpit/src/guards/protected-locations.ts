// Owns the machine facts behind the guard protections: the directories holding the code the
// running guard loads, the command search path directories inside the allowed roots, the identity
// of every file in the root secrets directory, the environment and secrets names below a searched
// tree or tracked by a repository, and which launcher spellings start the installed cockpit. It reads
// the filesystem and asks Git, and decides nothing; the guard application filters these facts into the
// policy and the evaluator turns them into hard denials.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, posix, relative } from 'node:path'

import { ENVIRONMENT_CODES, snapshotExecutionStep, type ExecutionStep, RefusalError } from '../environment/contract.js'
import type { ResolvedExecutable } from '../environment/executable.js'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { foldGuardSpelling, GUARD_LOCATION_LIMITS, GUARD_SECRET_FILE_LIMIT, guardIdentity } from './evaluator.js'

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

/** The directory Node loads a bare specifier from: the nearest `node_modules/<name>` above `from`. */
function installedPackage(from: string, name: string): string {
    for (let directory = from; ; directory = dirname(directory)) {
        const candidate = join(directory, 'node_modules', name)
        try {
            if (lstatSync(candidate)) return candidate
        } catch (error) {
            if (!missing(error)) throw error
        }
        if (dirname(directory) === directory) throw new RefusalError(`guard dependency ${name} is not installed above ${from}`)
    }
}

/**
 * The running cockpit package and every package it loads, each under the spelling it was found by
 * and its real path, plus the consumer's `node_modules` spelling of the package when that is a link
 * to it. The guard authenticates only its entry point, so all of these are controls.
 */
export function guardInstalledDirectories(packageRoot: string, consumerRoot: string): readonly string[] {
    const found = new Set<string>()
    const visited = new Set<string>()
    const pending = [packageRoot]
    const { name } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name: string }
    const linked = join(consumerRoot, 'node_modules', name)
    try {
        if (realpathSync(linked) === realpathSync(packageRoot)) pending.push(linked)
    } catch (error) {
        if (!missing(error)) throw error
    }
    while (pending.length) {
        const spelled = pending.pop()!
        const real = realpathSync(spelled)
        found.add(spelled).add(real)
        if (visited.has(real)) continue
        visited.add(real)
        if (found.size > GUARD_LOCATION_LIMITS.packageDirectories) throw new RefusalError(`guard package closure exceeds ${GUARD_LOCATION_LIMITS.packageDirectories} directories`)
        const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
        for (const name of Object.keys(manifest.dependencies ?? {})) pending.push(installedPackage(real, name))
    }
    return [...found].sort()
}

/**
 * The file whose identity proves that `executable` with the launcher `words` after it, run in `cwd`,
 * starts `launcher`, the installed cockpit the guard runs from, or undefined when it may start
 * something else. A path, or the script `node` is given, qualifies when it resolves to the launcher;
 * the bare name when the first `cockpit` on the command search path does. `npx` qualifies only in
 * `root`, where npm runs a `bin` the root package.json declares before any installed one and applies
 * the root `.npmrc`, whose `script-shell` and `node-options` run other code first; with neither
 * present it runs the root's `node_modules/.bin/cockpit`, which must resolve to the launcher.
 */
export function guardLauncherEvidence(executable: string, words: readonly string[], cwd: string, root: string, launcher: string, searchPath: string): string | undefined {
    const resolving = (path: string) => {
        try { return realpathSync(path) === launcher ? path : undefined } catch (error) {
            if (missing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
            throw error
        }
    }
    if (executable.includes('/')) return resolving(posix.resolve(cwd, executable))
    if (executable === 'node') return resolving(posix.resolve(cwd, words[0]!))
    if (executable === 'cockpit') {
        // The shell runs the first executable file the search path names; an empty entry is `cwd`.
        for (const entry of searchPath.split(':')) {
            const candidate = posix.resolve(cwd, entry, 'cockpit')
            let status
            try { status = statSync(candidate) } catch (error) {
                if (missing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue
                throw error
            }
            if (status.isFile() && status.mode & 0o111) return resolving(candidate)
        }
        return undefined
    }
    if (executable !== 'npx' || cwd !== root) return undefined
    try {
        lstatSync(join(root, '.npmrc'))
        return undefined
    } catch (error) {
        if (!missing(error)) throw error
    }
    let manifest: unknown = {}
    try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch (error) {
        if (error instanceof SyntaxError) return undefined
        if (!missing(error)) throw error
    }
    // npm reads a bin from `bin`, or from every file in `directories.bin`. Its other `directories`
    // entries name documentation, and `npm init` writes `directories.doc` beside the docs/ sync creates.
    const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    if (!record(manifest) || 'bin' in manifest || 'directories' in manifest && (!record(manifest.directories) || 'bin' in manifest.directories)) return undefined
    return resolving(join(root, 'node_modules/.bin/cockpit'))
}

/**
 * Absolute search path entries, and their real paths, that lie inside an allowed root. A relative
 * entry resolves against whatever directory a command runs in, so it names no fixed location.
 */
export function guardSearchDirectories(searchPath: string, allowedRoots: readonly string[]): readonly string[] {
    const inside = (path: string) => allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))
    const found = new Set<string>()
    for (const entry of searchPath.split(':')) {
        if (!entry.startsWith('/')) continue
        const spelled = posix.normalize(entry).replace(/(?<=.)\/+$/, '')
        const candidates = [spelled]
        try { candidates.push(realpathSync(spelled)) } catch (error) { if (!missing(error)) throw error }
        for (const candidate of candidates) if (inside(candidate)) found.add(candidate)
    }
    if (found.size > GUARD_LOCATION_LIMITS.searchPathDirectories) throw new RefusalError(`guard search path exceeds ${GUARD_LOCATION_LIMITS.searchPathDirectories} directories inside the allowed roots`)
    return [...found].sort()
}

/** The first entry of `searchPath` that is not absolute, an empty one included, or null when there is none. */
export function guardSearchPathRelativeEntry(searchPath: string): string | null {
    return searchPath.split(':').find((entry) => !entry.startsWith('/')) ?? null
}

/** Directory entries a recursive search may walk before the guard stops proving what it reads. */
const GUARD_SEARCH_ENTRY_LIMIT = 20_000

const sensitiveName = (name: string) => { const folded = foldGuardSpelling(name); return folded.startsWith('.env') || folded === '.secrets' }

/**
 * Every path at or below `path` whose case-folded name starts with `.env` or is `.secrets`, of any
 * type, without following links, as a recursive search would reach it; null once the walk passes
 * `entryLimit` entries or finds more than the sensitive path bound. A missing path has none.
 */
export function guardSensitivePathsBelow(path: string, entryLimit = GUARD_SEARCH_ENTRY_LIMIT): readonly string[] | null {
    let status
    try { status = lstatSync(path) } catch (error) { if (missing(error)) return []; throw error }
    const found = sensitiveName(basename(path)) ? [path] : []
    const pending = status.isDirectory() ? [path] : []
    let seen = 0
    while (pending.length) {
        const directory = pending.pop()!
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (++seen > entryLimit) return null
            const child = join(directory, entry.name)
            if (sensitiveName(entry.name) && found.push(child) > GUARD_LOCATION_LIMITS.sensitivePaths) return null
            if (entry.isDirectory()) pending.push(child)
        }
    }
    return found.sort()
}

export type GuardExecute = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>

// A repository's index and work tree can each list hundreds of thousands of paths.
const GIT_LIST_BYTES = 16_777_216
// Ignored entries Git lists below a searched tree, each ignored directory once. Each costs at most a
// check of its not-yet-seen ancestors for a repository boundary, the work of one step of the walk,
// so the walk's budget bounds it.
const GUARD_IGNORED_ENTRY_LIMIT = GUARD_SEARCH_ENTRY_LIMIT

/**
 * The NUL-separated paths `git <args>` prints in `repository`, with an empty answer for exit 1, or
 * null when Git did not answer. The configuration overrides keep Git from running the fsmonitor
 * program or trusting its untracked cache, and match ignore rules case-sensitively, as ripgrep does.
 */
async function gitPaths(git: ResolvedExecutable, repository: string, args: readonly string[], execute: GuardExecute): Promise<readonly string[] | null> {
    const step = snapshotExecutionStep({
        id: 'guard-git-paths',
        argv: [git.canonicalPath, '-C', repository, `--work-tree=${repository}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.ignoreCase=false', ...args],
        argv0: git.invocationPath, cwd: repository, env: {}, timeoutMs: 10_000,
        stdoutLimitBytes: GIT_LIST_BYTES, stderrLimitBytes: 65_536, paths: [repository], ports: [], labels: { action: 'guard-git-paths' },
        expected: [{ kind: 'path', target: repository, state: 'repository' }],
        consumedFiles: [{ path: git.canonicalPath, sha256: git.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: git.executionMode }],
        filesystemChecks: [], compensation: [],
    })
    if (!step) throw new RefusalError(`guard Git query could not be planned in ${repository}`)
    const outcome = authenticatedExecutionOutcome(await execute(step), step)
    if (outcome?.kind === 'complete') return outcome.stdout.toString('utf8').split('\0').filter(Boolean)
    return outcome?.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED
        && outcome.execution.exitCode === 1 && outcome.execution.signal === null ? [] : null
}

// A `.gitignore` is a short list of patterns; one past this is not read.
const IGNORE_FILE_BYTES = 1_048_576

/**
 * Whether Git and ripgrep may disagree on what an ignore line matches. They compile globs with
 * different engines: ripgrep reads `{a,b}` as alternatives where Git matches the braces literally,
 * does not know POSIX classes such as `[[:alpha:]]`, and in older releases refuses a `**` that is not
 * a whole path component, skipping the line. Git trims only trailing spaces where ripgrep trims any
 * trailing whitespace. Each lets Git ignore a file ripgrep reads, so the walk decides instead of
 * Git's list. A backslash escape counts too: no check here proves both engines read every escape alike.
 */
function divergentIgnoreLine(line: string): boolean {
    if (line.startsWith('#')) return false
    const pattern = line.replace(/^!/, '')
    return /[{}\\]|\[[:=.]|\s$/u.test(pattern) || pattern.split('/').some(component => component.includes('**') && component !== '**')
}

function present(path: string): boolean {
    try { lstatSync(path); return true } catch (error) { if (missing(error)) return false; throw error }
}

/** The nearest directory at or above `directory` holding a `.git` entry, or undefined. */
function repositoryAbove(directory: string): string | undefined {
    for (let cursor = directory; ; cursor = dirname(cursor)) {
        if (present(join(cursor, '.git'))) return cursor
        if (dirname(cursor) === cursor) return undefined
    }
}

/**
 * The paths a default ripgrep search of `path` reads that are named `.env*`, lie below a `.secrets`
 * directory or are one of `watched`, each reported at its first such name, as Git lists what the
 * enclosing repository does not ignore; null past the sensitive path bound. Undefined when Git
 * did not answer or its list cannot stand for ripgrep's: outside a repository, through a
 * nested repository or submodule, below an `.ignore` or `.rgignore` file, which ripgrep reads and Git
 * does not, or when the search names an ignored directory, whose children ripgrep may still read.
 *
 * Only `.gitignore` files are applied: ripgrep reads those, the repository's exclude file and the
 * global excludes file, but finds the global one by other rules than Git, so Git applying fewer
 * lists more. Hidden paths are kept: a type such as `rg -t sh`, which matches `.env`, reads them.
 * Undefined as well when a `.gitignore` Git reads holds a line the two may match differently.
 */
export async function guardUnignoredSensitivePaths(path: string, watched: readonly string[], git: ResolvedExecutable, execute: GuardExecute): Promise<readonly string[] | null | undefined> {
    // ripgrep reads a path it is named whatever ignores it, and one such name already decides.
    if (sensitiveName(basename(path))) return [path]
    const status = lstatSync(path)
    // A case-insensitive volume finds `SRC` where Git's pathspec and ignore rules see only `src`.
    if (realpathSync.native(path) !== path) return undefined
    const start = status.isDirectory() ? path : dirname(path)
    for (let cursor = start; ; cursor = dirname(cursor)) {
        if (present(join(cursor, '.ignore')) || present(join(cursor, '.rgignore'))) return undefined
        if (dirname(cursor) === cursor) break
    }
    const repository = repositoryAbove(start)
    if (repository === undefined) return undefined
    const below = relative(repository, path)
    // check-ignore takes no pathspec magic, so a name it would read as magic or a wildcard is walked.
    if (/^:|[*?[\\]/.test(below)) return undefined
    const scope = below === '' ? [] : [`:(literal)${below}`]
    // `--directory` names an ignored directory once instead of reading everything below it, which
    // ripgrep skips as well; listing every ignored entry, not only protected names, keeps each
    // directory Git collapsed in view whatever its name.
    const [named, cached, others, ignored] = await Promise.all([
        below === '' ? [] : gitPaths(git, repository, ['check-ignore', '--no-index', '--', below], execute),
        gitPaths(git, repository, ['ls-files', '-z', '--stage', '--', ...scope], execute),
        gitPaths(git, repository, ['ls-files', '-z', '--others', '--exclude-per-directory=.gitignore', '--', ...scope], execute),
        gitPaths(git, repository, ['ls-files', '-z', '--others', '--ignored', '--directory', '--exclude-per-directory=.gitignore', '--', ...scope], execute),
    ])
    if (named?.length !== 0 || cached === null || others === null || ignored === null || ignored.length > GUARD_IGNORED_ENTRY_LIMIT) return undefined
    const folded = new Set(watched.map(foldGuardSpelling))
    const boundaries = new Map<string, boolean>()
    // ripgrep stops applying the ignore files above a directory holding `.git` or `.jj`, which Git
    // does not, so what Git ignores below such a directory may still be read.
    const belowBoundary = (directory: string): boolean => {
        if (directory === repository) return false
        let known = boundaries.get(directory)
        if (known === undefined) {
            known = ['.git', '.jj'].some(name => present(join(directory, name))) || belowBoundary(dirname(directory))
            boundaries.set(directory, known)
        }
        return known
    }
    for (const entry of ignored) {
        const names = entry.split('/').filter(Boolean)
        if (names.some(name => ['.ignore', '.rgignore'].includes(foldGuardSpelling(name)))) return undefined
        const absolute = join(repository, ...names)
        if (absolute !== path && !absolute.startsWith(`${path}/`)) return undefined
        // A collapsed directory may hold anything; a file matters only under a protected name.
        const protectedEntry = entry.endsWith('/') || names.some(sensitiveName) || folded.has(foldGuardSpelling(absolute))
        if (protectedEntry && belowBoundary(dirname(absolute))) return undefined
    }
    const listed: string[] = []
    for (const line of cached) {
        const tab = line.indexOf('\t')
        // A submodule's work tree is ripgrep's to search and absent from this index.
        if (tab < 0 || line.startsWith('160000 ')) return undefined
        listed.push(line.slice(tab + 1))
    }
    for (const entry of others) {
        // Git names an untracked nested repository as a directory and lists nothing inside it.
        if (entry.endsWith('/')) return undefined
        listed.push(entry)
    }
    // Git reads the `.gitignore` in each directory it enters: those from the repository down to the
    // search, and those it lists below it under any status. One that is not a plain file, such as a
    // link Git declines to follow and ripgrep follows, is not proven to say the same to both.
    const ignoreFiles = new Set<string>()
    for (let cursor = start; ; cursor = dirname(cursor)) {
        ignoreFiles.add(join(cursor, '.gitignore'))
        if (cursor === repository) break
    }
    for (const entry of [...listed, ...ignored]) if (foldGuardSpelling(basename(entry)) === '.gitignore') ignoreFiles.add(join(repository, entry))
    for (const file of ignoreFiles) {
        let status
        try { status = lstatSync(file) } catch (error) { if (missing(error)) continue; throw error }
        if (!status.isFile() || status.size > IGNORE_FILE_BYTES) return undefined
        // ripgrep stops reading an ignore file at its first line that is not UTF-8; Git reads on.
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)) } catch (error) {
            if (error instanceof TypeError && (error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return undefined
            throw error
        }
        if (text.split('\n').some(divergentIgnoreLine)) return undefined
    }
    const found = new Set<string>()
    for (const entry of listed) {
        if (entry.split('/').some(name => ['.ignore', '.rgignore'].includes(foldGuardSpelling(name)))) return undefined
        const absolute = join(repository, entry)
        // Every query is scoped to `path`, so an entry outside it is a spelling Git and the volume disagree on.
        if (absolute !== path && !absolute.startsWith(`${path}/`)) return undefined
        const names = absolute === path ? [] : relative(path, absolute).split('/')
        const first = names.findIndex(sensitiveName)
        if (first >= 0) found.add(join(path, ...names.slice(0, first + 1)))
        else if (folded.has(foldGuardSpelling(absolute))) found.add(absolute)
        if (found.size > GUARD_LOCATION_LIMITS.sensitivePaths) return null
    }
    return [...found].sort()
}

/**
 * Every path `repository`'s index holds that is named `.env*`, lies below a `.secrets` or `.env*`
 * directory or is one of `watched`, or null past the sensitive path bound or when Git did not
 * answer. Only the index is asked: a file removed from it stays in history, which this does not walk.
 */
export async function guardTrackedSensitivePaths(repository: string, watched: readonly string[], git: ResolvedExecutable, execute: GuardExecute): Promise<readonly string[] | null> {
    const inside = watched.map(path => relative(repository, path)).filter(path => path !== '' && !path.startsWith('..'))
    const tracked = await gitPaths(git, repository, ['ls-files', '-z', '--', ':(icase,glob)**/.env*', ':(icase,glob)**/.env*/**', ':(icase,glob)**/.secrets/**',
        ...inside.map(path => `:(icase,literal)${path}`)], execute)
    return tracked === null || tracked.length > GUARD_LOCATION_LIMITS.sensitivePaths ? null : tracked.map(path => join(repository, path)).sort()
}

/**
 * Identities of every file in each case-folded spelling of `env/.secrets` below `root`, and whether
 * any has a second hard link; `identities` is null once more than the bound of entries was seen,
 * which leaves every read unproven rather than silently uncovered.
 */
export function guardSecretFiles(root: string): { readonly identities: readonly string[] | null; readonly linked: boolean } {
    const directories = (parent: string, name: string) => {
        let entries: string[]
        try { entries = readdirSync(parent) } catch (error) { if (missing(error)) return []; throw error }
        return entries.filter((entry) => foldGuardSpelling(entry) === name).map((entry) => join(parent, entry))
            .filter((path) => { const status = lstatSync(path); return status.isDirectory() && !status.isSymbolicLink() })
    }
    const pending = directories(root, 'env').flatMap((env) => directories(env, '.secrets'))
    const identities: string[] = []
    let linked = false
    let seen = 0
    while (pending.length) {
        const directory = pending.pop()!
        for (const entry of readdirSync(directory)) {
            if (++seen > GUARD_SECRET_FILE_LIMIT) return { identities: null, linked: true }
            const path = join(directory, entry)
            const status = lstatSync(path)
            if (status.isDirectory()) pending.push(path)
            else if (status.isFile()) {
                identities.push(guardIdentity(status))
                if (status.nlink > 1) linked = true
            }
        }
    }
    return { identities: identities.sort(), linked }
}
