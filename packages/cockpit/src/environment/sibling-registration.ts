/**
 * Owns `cockpit sibling add` and `cockpit sibling remove`: they grow and prune the `[[sibling]]`
 * tables of cockpit.toml so an agent or a human never hand-edits them.
 *
 * It decides which row to record and why; the text edit lives in `config/sibling-toml.ts` and the
 * verified write in `config/verified-write.ts`. It never clones, moves or deletes a checkout, and
 * it never talks to a remote host: the only child processes are local `git init` and a local read
 * of an existing checkout's `origin`, and both cross the supplied `execute`, which production
 * binds to `environment-exec/execute.ts`. Before editing, it reads (never writes) the checkout
 * identity through `setup-observation.ts` and the stack's lifecycle record, so it can refuse an
 * edit that would strand a recorded stack.
 */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { parse } from 'smol-toml'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { loadCockpitConfig, readBoundedInput } from '../config/load.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { appendSiblingTable, recordSiblingRemote, removeSiblingTable, type SiblingEdit, type SiblingTableRow } from '../config/sibling-toml.js'
import { writeVerifiedConfig } from '../config/verified-write.js'
import type { Diagnostic } from '../diagnostics.js'
import { CockpitConfig, deriveSiblingVariable, Mount, runtimeDeclarationSha256, Sibling } from '../schema.js'
import { ENVIRONMENT_CODES, type ExecutionStep, type FilesystemAncestorIdentity } from './contract.js'
import { declaredRuntime } from './declaration.js'
import { resolveGitExecutable, type ResolvedExecutable } from './executable.js'
import { stackId } from './identity.js'
import { decodeLifecycleRecord } from './lifecycle-stage.js'
import { observeGeneratedCheckoutIdentity } from './setup-observation.js'
import { readState, selectStateRoot } from './state.js'

export const mechanism = {
    id: 'sibling-registration',
    module: 'packages/cockpit/src/environment/sibling-registration.ts',
    exports: ['initializeLocalGitRepository', 'runSiblingAdd', 'runSiblingRemove'],
} as const

export interface SiblingAddInput {
    readonly configPath: string
    readonly slug: string
    readonly create: boolean
    readonly from?: string
    readonly remote?: string
    readonly dir?: string
    readonly purpose?: string
    readonly varName?: string
    /** How the stack uses the checkout; defaulted from the declared runtime when absent. */
    readonly mount?: string
    readonly instructionPointer?: boolean
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface SiblingRemoveInput {
    readonly configPath: string
    readonly slug: string
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface SiblingDependencies {
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
}

export interface SiblingOutcome {
    readonly status: number
    readonly result: unknown
    readonly diagnostics: readonly Diagnostic[]
    readonly artifact?: string | null
    readonly destination?: string | null
}

const STEP_TIMEOUT_MS = 10_000
const FREE_TEXT_UNSAFE = /[\u0000-\u001f\u007f]/

function refused(code: string, message: string, target?: string): SiblingOutcome {
    return Object.freeze({ status: 2, result: null, artifact: null, destination: null,
        diagnostics: Object.freeze([Object.freeze({ severity: 'error' as const, code, message, ...(target === undefined ? {} : { target }) })]) })
}

function usage(message: string, target?: string): SiblingOutcome {
    return refused('CLI_USAGE_INVALID', message, target)
}

/** Key order must not matter when two parsed configurations are compared. */
function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : 1)) : item)
}

function gitStep(executable: ResolvedExecutable, cwd: string, env: Readonly<Record<string, string>>, id: string, args: readonly string[]): ExecutionStep {
    return Object.freeze({
        id,
        argv: Object.freeze([executable.canonicalPath, ...args]) as readonly [string, ...string[]],
        argv0: executable.invocationPath,
        cwd, env, timeoutMs: STEP_TIMEOUT_MS,
        stdoutLimitBytes: 4_096, stderrLimitBytes: 4_096,
        paths: Object.freeze([]), ports: Object.freeze([]),
        labels: Object.freeze({ purpose: id }),
        expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({
            path: executable.canonicalPath, sha256: executable.sha256,
            maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true as const,
            executionMode: executable.executionMode,
        })]),
        filesystemChecks: Object.freeze([]),
        compensation: Object.freeze([]),
    })
}

type GitResult = Readonly<{ kind: 'complete'; text: string }> | Readonly<{ kind: 'failed'; exitCode: number; detail: string }>

async function runGit(dependencies: SiblingDependencies, step: ExecutionStep): Promise<GitResult> {
    const outcome = authenticatedExecutionOutcome(await dependencies.execute(step), step)
    if (!outcome) return { kind: 'failed', exitCode: -1, detail: 'the execution outcome could not be authenticated' }
    const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim()
    if (outcome.kind !== 'complete') {
        const stderr = decode(outcome.stderr)
        return { kind: 'failed', exitCode: outcome.execution.exitCode, detail: `${outcome.code}${stderr ? `: ${stderr.split('\n', 1)[0]!.slice(0, 256)}` : ''}` }
    }
    return { kind: 'complete', text: decode(outcome.stdout) }
}

export type GitRepositoryInitializationOutcome = Readonly<{ kind: 'complete' }>
    | Readonly<{ kind: 'refusal'; reason: string }>

/** Initialises one local repository through the authenticated process seam used by sibling creation. */
export async function initializeLocalGitRepository(
    input: Readonly<{ path: string; env: Readonly<Record<string, string | undefined>> }>,
    dependencies: SiblingDependencies,
): Promise<GitRepositoryInitializationOutcome> {
    const searchEnvironment = input.env
    const refuse = (reason: string): GitRepositoryInitializationOutcome => ({ kind: 'refusal',
        reason: `${input.path}: ${reason}; choose an empty directory or an existing local Git repository` })
    const git = await resolveGitExecutable(searchEnvironment)
    if (git.state !== 'available') return refuse(git.reason)
    try {
        const directory = await lstat(input.path)
        if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(input.path) !== input.path) {
            return refuse('the dedicated cockpit directory is not a canonical plain directory')
        }
        const entries = await readdir(input.path)
        if (entries.length > 0) {
            if (!entries.includes('.git')) return refuse('the dedicated cockpit directory already contains unrelated files')
            const metadata = await lstat(resolve(input.path, '.git'))
            if (!metadata.isDirectory() || metadata.isSymbolicLink()
                || await realpath(resolve(input.path, '.git')) !== resolve(input.path, '.git')) {
                return refuse('the existing Git metadata must be a plain local .git directory')
            }
        } else {
            const ancestors: FilesystemAncestorIdentity[] = []
            for (let path = dirname(input.path);;) {
                const status = await lstat(path)
                if (!status.isDirectory() || status.isSymbolicLink()) return refuse('a parent directory changed before initialization')
                ancestors.unshift({ path, dev: status.dev, ino: status.ino })
                if (dirname(path) === path) break
                if (ancestors.length >= 64) return refuse('the directory ancestry exceeds the verification bound')
                path = dirname(path)
            }
            const initialised = await runGit(dependencies, {
                ...gitStep(git.value, dirname(input.path), { PATH: input.env.PATH ?? '' }, 'repository:init', ['init', input.path]),
                paths: [input.path],
                filesystemChecks: [
                    { path: input.path, expected: 'directory', identity: { dev: directory.dev, ino: directory.ino, ancestors } },
                    { path: resolve(input.path, '.git'), expected: 'absent' },
                ],
            })
            if (initialised.kind !== 'complete') return refuse(`git init failed (${initialised.detail})`)
            const metadata = await lstat(resolve(input.path, '.git'))
            if (!metadata.isDirectory() || metadata.isSymbolicLink()
                || await realpath(resolve(input.path, '.git')) !== resolve(input.path, '.git')) {
                return refuse('git init did not create plain local metadata')
            }
        }
        const top = await runGit(dependencies, gitStep(git.value, input.path,
            { PATH: input.env.PATH ?? '' }, 'repository:root', ['rev-parse', '--show-toplevel']))
        if (top.kind !== 'complete' || top.text !== input.path) {
            return refuse('the Git repository does not belong to this exact directory')
        }
        return { kind: 'complete' }
    } catch (error) {
        return refuse(`the local repository could not be verified (${error instanceof Error ? error.message : String(error)})`)
    }
}

function remoteProblem(remote: string): string | undefined {
    if (remote.startsWith('-')) return 'a remote that starts with "-" would be read as a git option'
    if (/\s/.test(remote) || FREE_TEXT_UNSAFE.test(remote)) return 'a remote cannot contain whitespace or control characters'
    return undefined
}

/** The deepest existing ancestor must resolve inside the siblings root, so a symlinked path cannot send `git init` elsewhere. */
async function confinedBelow(root: string, target: string): Promise<boolean> {
    let probe = target
    for (;;) {
        try {
            const real = await realpath(probe)
            const realRoot = await realpath(root)
            return real === realRoot || real.startsWith(`${realRoot}${sep}`)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || probe === dirname(probe)) return false
            probe = dirname(probe)
        }
    }
}

async function kind(path: string): Promise<'absent' | 'directory' | 'other'> {
    try {
        const entry = await lstat(path)
        return entry.isDirectory() ? 'directory' : 'other'
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
        throw error
    }
}

interface Prepared {
    readonly text: string
    readonly expected: CockpitConfig
}

/**
 * Build the edited text and the exact configuration it must parse to. The schema is run on the
 * candidate before any directory is touched, so a refusal never leaves a stray repository behind.
 */
function prepare(base: CockpitConfig, edit: SiblingEdit, siblings: readonly unknown[]): Prepared | SiblingOutcome {
    if (edit.kind === 'unsupported') return refused(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, `cockpit.toml cannot be edited safely: ${edit.reason}; nothing was written`, 'sibling')
    const expected = { ...base, sibling: siblings } as CockpitConfig
    let parsed
    try { parsed = CockpitConfig.safeParse(parse(edit.text)) } catch (error) {
        return refused(ENVIRONMENT_CODES.CONFIG_PARSE_INVALID, `the edit would leave cockpit.toml unparseable (${error instanceof Error ? error.message.split('\n', 1)[0] : 'unknown'}); nothing was written`, 'sibling')
    }
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return refused(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
            `the edit would leave cockpit.toml invalid (${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'schema'}); nothing was written`, 'sibling')
    }
    if (canonical(parsed.data) !== canonical(expected)) {
        return refused(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, 'the edit would change more than the one sibling table; nothing was written. Edit cockpit.toml by hand', 'sibling')
    }
    return { text: edit.text, expected }
}

const isOutcome = (value: Prepared | SiblingOutcome): value is SiblingOutcome => 'diagnostics' in value

async function commit(path: string, sha256: string, prepared: Prepared, verb: string): Promise<SiblingOutcome | null> {
    const written = await writeVerifiedConfig({
        path, expectedSha256: sha256, temporaryTag: 'sibling',
        edit: () => prepared.text,
        isExactChange: (config) => canonical(config) === canonical(prepared.expected),
        messages: {
            changedBefore: `cockpit.toml changed since it was read; nothing was written. Re-run sibling ${verb}`,
            changedDuring: `cockpit.toml changed while the edit was being prepared; nothing was written. Re-run sibling ${verb}`,
            invalid: (reason) => `the edit would leave cockpit.toml invalid (${reason}); nothing was written`,
            notExact: `the edit would change more than the one sibling table; nothing was written. Edit cockpit.toml by hand`,
            writtenMismatch: 'the table was written, but re-reading cockpit.toml shows a change beyond it; inspect the file before running sync',
        },
    })
    return written.kind === 'complete' ? null : refused(written.code, written.message, path)
}

type LoadedConfig = Extract<Awaited<ReturnType<typeof loadCockpitConfig>>, { kind: 'complete' }>['result']

/**
 * A recorded stack runs the runtime declarations it was started from, and `up` refuses to resume it
 * once they differ. A row the stack does not use (mount "none", named by no generated service)
 * leaves them unchanged and is written at once; any other row would change the environment under
 * the stack, so that edit is refused before anything is written, while `down` still works.
 */
async function refuseWhileStackRecorded(loaded: LoadedConfig, edited: CockpitConfig, env: SiblingAddInput['env']): Promise<SiblingOutcome | undefined> {
    if (runtimeDeclarationSha256(edited) === loaded.runtimeSha256) return undefined
    const configPath = loaded.source.path
    // Lifecycle commands start a stack only for a declared runtime on these platforms, so no other
    // cockpit can have one recorded.
    if (declaredRuntime(loaded.config.environment) === 'none' || (process.platform !== 'darwin' && process.platform !== 'linux')) return undefined
    const checkout = await observeGeneratedCheckoutIdentity({ source: loaded.source, cockpitName: loaded.config.cockpit.name, env })
    if (checkout.state === 'failed') return refused(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
        `cannot tell whether a stack started from ${configPath} is still recorded: ${checkout.reason}; nothing was written`, configPath)
    const namespace = await selectStateRoot({ platform: process.platform, home: env.HOME, xdgStateHome: env.XDG_STATE_HOME,
        checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath], cockpitId: checkout.cockpitId })
    if (namespace.kind !== 'complete') return refused(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
        `cannot tell whether a stack started from ${configPath} is still recorded: ${'message' in namespace ? namespace.message : 'the state root is missing'}; nothing was written`, configPath)
    const stack = stackId({ cockpitId: checkout.cockpitId, checkoutId: checkout.checkoutId, variant: { kind: 'shared' } })
    const address = namespace.value.paths.lifecycle(stack)
    const stored = await readState(address)
    if (stored.kind === 'missing') return undefined
    if (stored.kind !== 'complete') return refused(stored.code, `${stored.message}; nothing was written`, stored.target)
    const lifecycle = decodeLifecycleRecord(stored.value, { cockpitId: checkout.cockpitId, stackId: stack })
    if (!lifecycle) return refused(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'lifecycle progress record is malformed; nothing was written', address.path)
    if (lifecycle.value.teardownComplete === true) return undefined
    return refused('SIBLING_STACK_RECORDED',
        `a stack started from ${configPath} is still recorded, and this repository would change the environment underneath it; nothing was written — fix: run \`${cockpitCommand('down', { config: configPath })}\`, then rerun this command`,
        configPath)
}

export async function runSiblingAdd(input: SiblingAddInput, dependencies: SiblingDependencies): Promise<SiblingOutcome> {
    const searchEnvironment = input.env
    const modes = [input.create, input.from !== undefined, input.remote !== undefined].filter(Boolean).length
    if (modes > 1) return usage('--create, --from and --remote are mutually exclusive; choose the one that matches where the repository is')
    const slug = Sibling.shape.slug.safeParse(input.slug)
    if (!slug.success) return usage(`slug ${JSON.stringify(input.slug)} must be lowercase letters, digits and hyphens, starting with a letter or digit`, 'slug')
    for (const [name, value] of [['--purpose', input.purpose], ['--remote', input.remote], ['--from', input.from]] as const) {
        if (value !== undefined && (value.length === 0 || FREE_TEXT_UNSAFE.test(value))) return usage(`${name} must be non-empty text without control characters`, name)
    }
    if (input.remote !== undefined) {
        const problem = remoteProblem(input.remote)
        if (problem) return usage(`--remote: ${problem}`, '--remote')
    }

    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return Object.freeze({ status: 2, result: null, diagnostics: loaded.diagnostics })
    const configPath = loaded.result.source.path
    const config = loaded.result.config
    const configDir = dirname(configPath)
    const root = resolve(configDir, config.cockpit.siblings_root)

    const existing = config.sibling.findIndex((sibling) => sibling.slug === slug.data)
    const found = existing === -1 ? undefined : config.sibling[existing]!
    if (found !== undefined) {
        const recordsRemoteLater = input.remote !== undefined && found.acquire === 'none'
        if (!recordsRemoteLater) {
            return refused('SIBLING_SLUG_DUPLICATE',
                `sibling "${slug.data}" is already declared (dir "${found.dir}", acquire "${found.acquire}")`
                + `${found.acquire === 'none' ? '; to record its remote later use --remote <url>' : `; remove it first with ${cockpitCommand('sibling remove', { operand: slug.data, config: configPath })}`}`, slug.data)
        }
        if (input.dir !== undefined && input.dir !== found.dir) {
            return usage(`sibling "${slug.data}" already uses dir "${found.dir}"; --dir cannot move it`, '--dir')
        }
        if (await kind(resolve(root, found.dir)) !== 'directory') {
            return refused('SIBLING_DIRECTORY_MISSING',
                `sibling "${slug.data}" has acquire "none" but ${resolve(root, found.dir)} does not exist; create the directory first, or remove the sibling and add it with --remote to let setup clone it`, slug.data)
        }
        const text = await sourceText(configPath, loaded.result.source.sha256)
        if (typeof text !== 'string') return text
        const edit = recordSiblingRemote(text, existing, config.sibling.length, input.remote!)
        const updated = Sibling.parse({ ...found, acquire: 'auto', remote: input.remote })
        const prepared = prepare(config, edit, config.sibling.map((sibling, index) => index === existing ? updated : sibling))
        if (isOutcome(prepared)) return prepared
        const stranded = await refuseWhileStackRecorded(loaded.result, prepared.expected, input.env)
        if (stranded) return stranded
        const failure = await commit(configPath, loaded.result.source.sha256, prepared, 'add')
        if (failure) return failure
        return success('remote-recorded', configPath, updated, { dir: 'existing row', var: 'existing row', purpose: 'existing row' },
            `recorded remote ${input.remote} for sibling "${slug.data}" in ${configPath}; the existing directory ${resolve(root, found.dir)} was left as it is and nothing was cloned. `
            + `Run \`${cockpitCommand('setup', { config: configPath })}\` to verify the remote against the checkout.`)
    }

    if (input.purpose === undefined) {
        return usage('a new sibling needs --purpose, printed when its checkout is missing; say what the repository is for, e.g. --purpose "HTTP API for orders"', '--purpose')
    }
    const purpose = input.purpose
    const dir = input.dir ?? slug.data
    const dirCheck = Sibling.shape.dir.safeParse(dir)
    if (!dirCheck.success) return usage(`--dir ${JSON.stringify(dir)} must be "." or a confined relative path without dot segments`, '--dir')
    const varName = input.varName ?? deriveSiblingVariable(slug.data)
    if (!Sibling.shape.var.safeParse(varName).success) {
        return usage(`variable ${JSON.stringify(varName)} must be uppercase and must not control Docker, Compose or the host process; use a sibling-specific name such as ${deriveSiblingVariable(slug.data)}`, '--var')
    }
    const mount = siblingMount(input.mount, config)
    if ('diagnostics' in mount) return mount
    for (const sibling of config.sibling) {
        if (sibling.dir === dir) return refused('SIBLING_DIR_DUPLICATE', `dir "${dir}" is already used by sibling "${sibling.slug}"; choose another with --dir`, '--dir')
        if (sibling.var === varName) return refused('SIBLING_VAR_DUPLICATE', `variable ${varName} is already exported by sibling "${sibling.slug}"; choose another with --var`, '--var')
    }

    const target = resolve(root, dir)
    const state = await kind(target)
    let mode: 'existing' | 'create' | 'from' | 'remote' = 'existing'
    let remote: string | undefined
    let source: string | undefined
    const git = await resolveGitExecutable(searchEnvironment)

    if (input.create) {
        mode = 'create'
        if (state === 'other') return refused('SIBLING_PATH_NOT_EMPTY', `${target} exists and is not a directory; choose another --dir`, '--dir')
        if (state === 'directory' && (await readdir(target)).length > 0) {
            return refused('SIBLING_PATH_NOT_EMPTY', `${target} already has content; --create only initialises an empty or missing path. Use no mode flag to register an existing directory, or --dir for a new one`, '--dir')
        }
        if (await kind(root) !== 'directory') return refused('SIBLING_DIRECTORY_MISSING', `the siblings root ${root} does not exist`, 'cockpit.siblings_root')
        if (!await confinedBelow(root, target)) return refused('SIBLING_PATH_NOT_EMPTY', `${target} resolves outside the siblings root through a symbolic link`, '--dir')
        if (git.state !== 'available') return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, git.reason, 'git')
    } else if (input.from !== undefined) {
        mode = 'from'
        source = resolve(input.from)
        if (await kind(source) !== 'directory') return refused('SIBLING_DIRECTORY_MISSING', `--from ${source} is not a directory`, '--from')
        if (git.state !== 'available') return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, git.reason, 'git')
        const origin = await runGit(dependencies, gitStep(git.value, configDir, { PATH: input.env.PATH ?? '' }, 'sibling:origin',
            ['-C', source, 'config', '--get', 'remote.origin.url']))
        if (origin.kind === 'failed' && origin.exitCode !== 1) {
            return refused('SIBLING_GIT_FAILED', `could not read the origin of ${source} (${origin.detail}); is it a git checkout?`, '--from')
        }
        if (origin.kind === 'failed' || origin.text === '') {
            return refused('SIBLING_REMOTE_MISSING',
                `${source} has no "origin" remote, so setup would have nothing to clone. Either move the repository under ${root} and register it with --dir <name> (acquire "none"), or add a remote first (git -C ${source} remote add origin <url>) and re-run`, '--from')
        }
        const problem = remoteProblem(origin.text)
        if (problem) return refused('SIBLING_GIT_FAILED', `the origin of ${source} is not usable: ${problem}`, '--from')
        remote = origin.text
    } else if (input.remote !== undefined) {
        mode = 'remote'
        remote = input.remote
    } else if (state !== 'directory') {
        return refused('SIBLING_DIRECTORY_MISSING',
            `${target} does not exist. Create it first, or say where the repository comes from: --create (new, git init), --from <path> (an existing checkout elsewhere) or --remote <url>`, '--dir')
    }

    const acquire = remote === undefined ? 'none' : 'auto'
    const row: SiblingTableRow = { slug: slug.data, dir, ...(remote === undefined ? {} : { remote }), mount: mount.value, acquire, var: varName,
        toolchain: 'none', ...(input.instructionPointer === true ? { instruction_pointer: true } : {}), purpose }
    const original = await sourceText(configPath, loaded.result.source.sha256)
    if (typeof original !== 'string') return original
    const edit = appendSiblingTable(original, row, config.sibling.length)
    const added = Sibling.parse(row)
    const prepared = prepare(config, edit, [...config.sibling, added])
    if (isOutcome(prepared)) return prepared
    const stranded = await refuseWhileStackRecorded(loaded.result, prepared.expected, input.env)
    if (stranded) return stranded

    if (mode === 'create') {
        if (git.state !== 'available') return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, git.reason, 'git')
        const initialised = await runGit(dependencies, gitStep(git.value, configDir, { PATH: input.env.PATH ?? '' }, 'sibling:init', ['init', target]))
        if (initialised.kind === 'failed') return refused('SIBLING_GIT_FAILED', `git init ${target} failed (${initialised.detail}); cockpit.toml was not changed`, '--create')
    }
    const failure = await commit(configPath, loaded.result.source.sha256, prepared, 'add')
    if (failure) {
        return mode === 'create'
            ? Object.freeze({ ...failure, diagnostics: Object.freeze(failure.diagnostics.map((item) => Object.freeze({ ...item, message: `${item.message}. ${target} was initialised and is left in place` }))) })
            : failure
    }

    const sources = {
        dir: input.dir === undefined ? 'defaulted to the slug' : '--dir',
        var: input.varName === undefined ? 'derived from the slug' : '--var',
        mount: mount.source,
        purpose: '--purpose',
    }
    // Creating a hosted repository is outward-facing, so cockpit only hands the commands over. The
    // JSON result carries them too: an agent reading --json would otherwise never see them.
    const publish = Object.freeze({
        command: `gh repo create <owner>/${slug.data} --private --source ${JSON.stringify(target)} --remote origin`,
        recordRemote: cockpitCommand('sibling add', { operand: slug.data, config: configPath, args: '--remote <url>' }),
    })
    const note = mode === 'create'
        ? `initialised ${target} and recorded sibling "${slug.data}" (acquire "none") in ${configPath}.\n`
          + `Creating a GitHub remote is outward-facing, so cockpit does not do it. To publish it yourself:\n`
          + `  ${publish.command}\n`
          + `then record the remote:\n  ${publish.recordRemote}`
        : mode === 'from'
            ? `recorded sibling "${slug.data}" with remote ${remote} read from the origin of ${source} (acquire "auto") in ${configPath}. The original checkout was not touched; \`${cockpitCommand('setup', { config: configPath })}\` clones a fresh copy to ${target}.`
            : mode === 'remote'
                ? `recorded sibling "${slug.data}" with remote ${remote} (acquire "auto") in ${configPath}; \`${cockpitCommand('setup', { config: configPath })}\` clones it to ${target}.`
                : `recorded the existing directory ${target} as sibling "${slug.data}" (acquire "none") in ${configPath}.`
    const mountNote = input.mount === undefined && mount.value === 'none'
        ? `\nIt is recorded as mount "none" because ${mount.source}. Once a service in ${config.environment.compose_files.join(', ')} bind-mounts \${${varName}}, `
          + 'change this row to mount = "always" so cockpit checks that mount and grants agents the checkout (pass --mount always when adding a sibling that is already mounted).'
        : ''
    return success(mode === 'create' ? 'created' : 'added', configPath, added, sources, `${note}${mountNote}`, { path: target,
        ...(source === undefined ? {} : { from: source }), ...(mode === 'create' ? { publish } : {}) })
}

type MountChoice = Readonly<{ value: Mount; source: string }>

/**
 * A compose-first cockpit's own Compose files decide what is mounted, and cockpit cannot add a bind
 * mount to them, so a new row there starts as "none": declaring "always" for a checkout no service
 * mounts made `check` pass and every later `up`, `sleep` and `down` refuse the runtime topology.
 */
function siblingMount(requested: string | undefined, config: CockpitConfig): MountChoice | SiblingOutcome {
    if (requested === undefined) {
        return declaredRuntime(config.environment) === 'compose'
            ? { value: 'none', source: 'this is a compose-first cockpit, and its own Compose files must bind-mount a mount = "always" sibling' }
            : { value: 'always', source: 'defaulted to always' }
    }
    if (requested === 'host') {
        return usage('--mount host needs a host_reason, which sibling add does not record; add the sibling with --mount none, then set mount = "host" and host_reason in cockpit.toml by hand', '--mount')
    }
    const parsed = Mount.safeParse(requested)
    if (!parsed.success) return usage(`--mount ${JSON.stringify(requested)} must be always, none or profile:<name> (lowercase letters, digits and hyphens)`, '--mount')
    return { value: parsed.data, source: '--mount' }
}

function success(action: string, configPath: string, row: unknown, sources: Record<string, string>, note: string, extra: Record<string, unknown> = {}): SiblingOutcome {
    return Object.freeze({ status: 0, diagnostics: Object.freeze([]), destination: null, artifact: `${note}\nNext: ${cockpitCommand('sync', { config: configPath, args: '--dry-run' })}\n`,
        result: Object.freeze({ action, config: configPath, sibling: row, sources, ...extra, next: cockpitCommand('sync', { config: configPath, args: '--dry-run' }) }) })
}

/** The text the edit is made on must be the text the configuration was parsed from. */
async function sourceText(path: string, sha256: string): Promise<string | SiblingOutcome> {
    const bytes = await readFile(path)
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
        return refused(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION, 'cockpit.toml changed while it was being read; nothing was written. Re-run the command', path)
    }
    return bytes.toString('utf8')
}

interface Reference { readonly where: string; readonly detail: string }

const siblingVariable = (row: Sibling) => new RegExp(`(?<![A-Z0-9_])${row.var}(?![A-Z0-9_])`)

/** Every place outside the row itself that names the sibling by slug, exported variable or projection file. */
function referencesTo(config: CockpitConfig, index: number): Reference[] {
    const row = config.sibling[index]!
    const variable = siblingVariable(row)
    const found: Reference[] = []
    const walk = (value: unknown, path: string) => {
        if (typeof value === 'string') {
            if (variable.test(value)) found.push({ where: path, detail: `mentions ${row.var}` })
            if (value.includes(`.sibling-${row.slug}-`)) found.push({ where: path, detail: `names a .sibling-${row.slug}-* projection file` })
        } else if (Array.isArray(value)) {
            value.forEach((item, position) => walk(item, `${path}[${position}]`))
        } else if (value !== null && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) {
                if (key === 'sibling' && item === row.slug) found.push({ where: `${path}.sibling`, detail: `references sibling "${row.slug}"` })
                else walk(item, path === '' ? key : `${path}.${key}`)
            }
        }
    }
    walk({ ...config, sibling: config.sibling.filter((_, position) => position !== index) }, '')
    return found
}

/**
 * A compose-first cockpit's own Compose files consume the sibling through its exported variable,
 * which cockpit.toml alone cannot show; removing the row would leave Compose an unset variable.
 */
async function composeReferencesTo(configDir: string, config: CockpitConfig, row: Sibling): Promise<Reference[] | SiblingOutcome> {
    const variable = siblingVariable(row)
    const found: Reference[] = []
    for (const composeFile of config.environment.compose_files) {
        const path = resolve(configDir, composeFile)
        let text: string
        try {
            const read = await readBoundedInput(path)
            if (read.kind === 'too-large') throw new Error('it exceeds the structured input limit')
            text = Buffer.from(read.bytes).toString('utf8')
        } catch (error) {
            return refused('COMPOSE_TOPOLOGY_UNAVAILABLE',
                `${path} could not be read (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : 'unknown error')}), so cockpit cannot tell whether it still uses ${row.var}; nothing was written`, composeFile)
        }
        if (variable.test(text)) found.push({ where: composeFile, detail: `mentions ${row.var}` })
    }
    return found
}

/** Projections exist only for guides a mounted sibling actually had, so the list is read from disk. */
async function existingGuideProjections(configDir: string, row: Sibling): Promise<string[]> {
    const flagged: string[] = []
    for (const guide of row.guides) {
        const name = `.sibling-${row.slug}-${guide.replaceAll('/', '-')}`
        try {
            await lstat(resolve(configDir, name))
            flagged.push(`${name} (guide projection)`)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            flagged.push(`${name} (guide projection; could not be inspected: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`)
        }
    }
    return flagged
}

export async function runSiblingRemove(input: SiblingRemoveInput): Promise<SiblingOutcome> {
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return Object.freeze({ status: 2, result: null, diagnostics: loaded.diagnostics })
    const configPath = loaded.result.source.path
    const config = loaded.result.config
    const index = config.sibling.findIndex((sibling) => sibling.slug === input.slug)
    if (index === -1) {
        return refused('SIBLING_NOT_FOUND', `no sibling "${input.slug}" in ${configPath}; declared: ${config.sibling.map((sibling) => sibling.slug).join(', ')}`, input.slug)
    }
    const row = config.sibling[index]!
    const composeReferences = await composeReferencesTo(dirname(configPath), config, row)
    if (!Array.isArray(composeReferences)) return composeReferences
    const references = [...referencesTo(config, index), ...composeReferences]
    if (references.length > 0) {
        return Object.freeze({ ...refused('SIBLING_REFERENCED',
            `sibling "${row.slug}" is still referenced, so its table was not removed. Remove or repoint these first: ${references.map((reference) => `${reference.where} (${reference.detail})`).join('; ')}`, row.slug),
            result: Object.freeze({ slug: row.slug, references }) })
    }
    const original = await sourceText(configPath, loaded.result.source.sha256)
    if (typeof original !== 'string') return original
    const edit = removeSiblingTable(original, index, config.sibling.length)
    const prepared = prepare(config, edit, config.sibling.filter((_, position) => position !== index))
    if (isOutcome(prepared)) return prepared
    const stranded = await refuseWhileStackRecorded(loaded.result, prepared.expected, input.env)
    if (stranded) return stranded
    const failure = await commit(configPath, loaded.result.source.sha256, prepared, 'remove')
    if (failure) return failure

    const flagged = [
        ...await existingGuideProjections(dirname(configPath), row),
        ...(row.derives?.generated ? [`the generated environment files derived from ${row.slug}'s generated row`] : []),
    ]
    const message = `removed sibling "${row.slug}" from ${configPath}. The checkout at ${resolve(dirname(configPath), config.cockpit.siblings_root, row.dir)} and every generated file were left alone.\n`
        + (flagged.length > 0 ? `The next sync will flag these for review: ${flagged.join('; ')}.\n` : '')
        + `Comments above the removed table were kept. Run \`${cockpitCommand('sync', { config: configPath, args: '--dry-run' })}\` to see exactly what changes before syncing.\n`
    return Object.freeze({ status: 0, diagnostics: Object.freeze([]), destination: null, artifact: message,
        result: Object.freeze({ action: 'removed', config: configPath, slug: row.slug, dir: row.dir, flaggedForReview: flagged, next: cockpitCommand('sync', { config: configPath, args: '--dry-run' }) }) })
}
