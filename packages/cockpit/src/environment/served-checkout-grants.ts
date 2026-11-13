/**
 * Grants the agent tools a sibling checkout `use` serves from outside the declared one. The grants
 * `sync` writes are committed and name the declared checkout, the same in every clone; a worktree
 * path is one person's disk, so it goes only where a tool reads a machine-local setting.
 *
 * Measured on 2026-11-04 beside an ungranted control directory, each run writing into both:
 * - Claude Code 2.1.319 (`claude -p --permission-mode acceptEdits`, 2026-11-06): a directory listed
 *   in `.claude/settings.local.json` `permissions.additionalDirectories` was written and the control
 *   refused, trusted or not. A trusted workspace combines it with the committed list; an untrusted one
 *   ignores the committed list. A string-valued list granted nothing from that file, with no report.
 * - OpenCode 1.19.5 (`opencode run`): the `{file:...}` grant file `sync` writes, holding the
 *   worktree path, allowed the write and the control was denied; a pattern naming a missing grant
 *   file stopped OpenCode at start, naming the file.
 * - Codex 0.166.0 (`codex exec`): no project file Codex reads is machine-local. Its project
 *   `.codex/config.toml` is committed and its only per-project user setting is the trust level;
 *   `--add-dir <dir>` at start made the worktree writable beside the committed roots, and without
 *   it the same write was refused.
 * Cursor and Grok Build were not installed, so nothing is written for them.
 */
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { readBoundedFile } from '../bounded-read.js'
import { GUARD_LOCAL_PATHS, writeCockpitLocalFiles } from '../guards/local-identity.js'
import { GUARD_SCRIPT_PATH, inspectGuardRecord } from '../guards/guard-record.js'
import { foldGuardSpelling, nestedAgentConfiguration } from '../guards/evaluator.js'
import type { SurfaceTarget } from '../surfaces/contract.js'
import { ENVIRONMENT_CODES, errorCause, isMissing, tryParseJson, type EnvironmentDiagnostic } from './contract.js'
import { openCodeGrantFile } from './generated-application/surface-outputs.js'

const CLAUDE_LOCAL_SETTINGS = '.claude/settings.local.json'
// What cockpit put in Claude's local settings, so a person's own entries are never taken back.
const ADDED_NAME = 'claude-local-grants'
const ADDED_PATH = `${GUARD_LOCAL_PATHS.directory}/${ADDED_NAME}`
const ADDED_FORMAT = 'cockpit-claude-local-grants/v1'
const SETTINGS_MAX_BYTES = 1_048_576

export function inside(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}${sep}`)
}

/**
 * The directory the OpenCode grant file names: the served checkout when it lies outside the
 * declared one, which the grant would not otherwise reach.
 */
export function openCodeGrantDirectory(declared: string, served: string | undefined): string {
    return served !== undefined && !inside(served, declared) ? served : declared
}

/** Why a directory cannot go into an OpenCode access pattern, or undefined when it can. */
export function openCodePatternUnsafe(directory: string): string | undefined {
    // The file's bytes become part of an OpenCode pattern: a wildcard would widen the grant and a
    // quote or backslash would change the JSON around it.
    return /[*?"\\\x00-\x1f\x7f]/.test(directory)
        ? `${directory} contains *, ?, a quote, a backslash or a control character, which OpenCode would read as part of its access pattern`
        : undefined
}

const HARNESS_NAMES: Readonly<Partial<Record<SurfaceTarget, string>>> = { codexcli: 'Codex', cursor: 'Cursor', grokcli: 'Grok Build' }

export interface AgentGrantPlan {
    readonly settings: Readonly<{ bytes: string | null }> | undefined
    readonly local: readonly Readonly<{ name: string; bytes: string }>[]
    /** What the tools can reach, for a served checkout outside the declared one. */
    readonly lines: readonly string[]
    readonly report: Readonly<{ granted: readonly SurfaceTarget[]; ungranted: readonly SurfaceTarget[] }> | undefined
}

type Planned = Readonly<{ kind: 'complete'; plan: AgentGrantPlan }> | Readonly<{ kind: 'refusal'; diagnostic: EnvironmentDiagnostic }>

function grantRefusal(message: string, target: string, fix: string): Readonly<{ kind: 'refusal'; diagnostic: EnvironmentDiagnostic }> {
    return { kind: 'refusal', diagnostic: { severity: 'error', code: ENVIRONMENT_CODES.SIBLING_CHECKOUT_RECORD_INVALID, message, target, fix } }
}

function plainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The JSON text of a local file, or undefined when there is none; a link or unreadable file is a reason. */
function readLocalJson(path: string): Readonly<{ value: unknown; bytes: string } | { reason: string }> | undefined {
    try {
        const read = readBoundedFile(path, SETTINGS_MAX_BYTES)
        if (read.kind === 'too-large') return { reason: `it is larger than ${SETTINGS_MAX_BYTES} bytes` }
        const bytes = read.bytes.toString('utf8')
        return { value: tryParseJson(bytes), bytes }
    } catch (error) {
        if (isMissing(error)) return undefined
        return { reason: `it could not be read as a plain file: ${errorCause(error)}` }
    }
}

/**
 * Plans the machine-local grants for one sibling. `served` is the checkout that serves it, or
 * undefined when the sibling is no longer declared; `targets` are the listed tools that hold a
 * committed grant for it. A grant cockpit added earlier for the sibling is taken back when the
 * served checkout no longer needs it.
 */
export async function planAgentGrants(input: Readonly<{
    root: string
    slug: string
    declared: string | undefined
    served: string | undefined
    targets: readonly SurfaceTarget[]
}>): Promise<Planned> {
    const outside = input.declared !== undefined && input.served !== undefined && !inside(input.served, input.declared) ? input.served : undefined
    const addedPath = join(input.root, ADDED_PATH)
    const recorded = readLocalJson(addedPath)
    const addedFix = `delete ${addedPath}, remove the additionalDirectories entries cockpit added from ${CLAUDE_LOCAL_SETTINGS}, then run this command again`
    if (recorded && 'reason' in recorded) return grantRefusal(`${addedPath} could not be read: ${recorded.reason}`, ADDED_PATH, addedFix)
    const record = recorded?.value
    if (recorded && !(plainObject(record) && record.format === ADDED_FORMAT && plainObject(record.directories)
        && Object.values(record.directories).every(directory => typeof directory === 'string'))) {
        return grantRefusal(`${addedPath} is not a record cockpit wrote (it does not carry the ${ADDED_FORMAT} format)`, ADDED_PATH, addedFix)
    }
    const added = { ...(plainObject(record) ? record.directories as Record<string, string> : {}) }
    const previous = Object.hasOwn(added, input.slug) ? added[input.slug] : undefined
    delete added[input.slug]
    const wantClaude = outside !== undefined && input.targets.includes('claudecode') ? outside : undefined

    let settings: AgentGrantPlan['settings']
    if (previous !== undefined || wantClaude !== undefined) {
        const settingsPath = join(input.root, CLAUDE_LOCAL_SETTINGS)
        const settingsFix = `make ${settingsPath} a JSON object whose permissions.additionalDirectories is a list of paths, or remove it, then run this command again`
        const current = readLocalJson(settingsPath)
        if (current && 'reason' in current) return grantRefusal(`${settingsPath} could not be read: ${current.reason}`, CLAUDE_LOCAL_SETTINGS, settingsFix)
        const object = current === undefined ? {} : current.value
        const permissions = plainObject(object) ? object.permissions ?? {} : undefined
        const listed = plainObject(permissions) ? permissions.additionalDirectories ?? [] : undefined
        // Claude Code drops a whole settings file it cannot load, so cockpit never rewrites one it cannot read either.
        if (!plainObject(object) || !plainObject(permissions) || !Array.isArray(listed) || !listed.every(entry => typeof entry === 'string')) {
            return grantRefusal(`${settingsPath} is not a Claude Code settings object cockpit can add a directory to`, CLAUDE_LOCAL_SETTINGS, settingsFix)
        }
        let directories = listed as string[]
        if (previous !== undefined && previous !== wantClaude && !Object.values(added).includes(previous)) {
            directories = directories.filter(directory => directory !== previous)
        }
        if (wantClaude !== undefined) {
            // A directory the person listed themselves stays theirs: cockpit neither records nor removes it.
            if (previous === wantClaude || !directories.includes(wantClaude)) added[input.slug] = wantClaude
            if (!directories.includes(wantClaude)) directories = [...directories, wantClaude]
        }
        if (directories.length !== listed.length || directories.some((directory, index) => directory !== listed[index])) {
            const { additionalDirectories: _replaced, ...otherPermissions } = permissions
            const nextPermissions = directories.length > 0 ? { ...otherPermissions, additionalDirectories: directories } : otherPermissions
            const { permissions: _permissions, ...otherSettings } = object
            const next = Object.keys(nextPermissions).length > 0 ? { ...otherSettings, permissions: nextPermissions } : otherSettings
            settings = { bytes: Object.keys(next).length > 0 ? `${JSON.stringify(next, null, 2)}\n` : null }
        }
    }
    const local: { name: string; bytes: string }[] = []
    if (previous !== added[input.slug]) local.push({ name: ADDED_NAME, bytes: `${JSON.stringify({ format: ADDED_FORMAT, directories: added })}\n` })
    if (input.declared !== undefined && input.targets.includes('opencode')) {
        const directory = openCodeGrantDirectory(input.declared, input.served)
        const unsafe = openCodePatternUnsafe(directory)
        if (unsafe) return grantRefusal(`OpenCode cannot be granted the checkout: ${unsafe}`, directory, 'move the checkout to a plain path, then run this command again')
        local.push({ name: basename(openCodeGrantFile(input.slug)), bytes: directory })
    }

    if (outside === undefined) return { kind: 'complete', plan: { settings, local, lines: [], report: undefined } }
    const granted = input.targets.filter(target => target === 'claudecode' || target === 'opencode')
    const ungranted = input.targets.filter(target => target !== 'claudecode' && target !== 'opencode')
    const lines = [
        ...granted.map(target => `${target === 'claudecode' ? 'Claude Code' : 'OpenCode'} may edit ${outside} through ${target === 'claudecode' ? CLAUDE_LOCAL_SETTINGS : openCodeGrantFile(input.slug)}, which only this machine reads; restart a session that is already running.`),
        ...ungranted.map(target => target === 'codexcli'
            ? `Codex has no machine-local setting for extra writable roots, so its sandbox still reaches only ${input.declared}; start Codex with --add-dir ${outside}.`
            : `${HARNESS_NAMES[target] ?? target} was not measured for a machine-local grant, so its grant still names only ${input.declared} and it may ask before editing ${outside}.`),
    ]
    return { kind: 'complete', plan: { settings, local, lines, report: { granted, ungranted } } }
}

/** Replaces Claude Code's local settings in one rename, or removes them when nothing is left; null bytes removes. */
async function writeClaudeLocalSettings(root: string, bytes: string | null): Promise<void> {
    const path = join(root, CLAUDE_LOCAL_SETTINGS)
    if (bytes === null) {
        await rm(path)
        return
    }
    const directory = join(root, '.claude')
    await mkdir(directory, { recursive: true })
    if ((await lstat(directory)).isSymbolicLink()) throw new Error(`${directory} is a symbolic link`)
    const temporary = join(directory, `.settings.local.json.${process.pid}.tmp`)
    try {
        await writeFile(temporary, bytes, { flag: 'wx' })
        await rename(temporary, path)
    } finally {
        await rm(temporary, { force: true })
    }
}

/** Writes a plan: cockpit's own record first, so a grant it added is never one it forgets. */
export async function applyAgentGrants(root: string, plan: AgentGrantPlan): Promise<Readonly<{ kind: 'complete' } | { kind: 'refusal'; diagnostic: EnvironmentDiagnostic }>> {
    if (plan.local.length > 0) {
        const written = await writeCockpitLocalFiles(root, plan.local)
        if (written.kind !== 'complete') return grantRefusal(`the agent tools' machine-local grants could not be written: ${written.message}`, GUARD_LOCAL_PATHS.directory,
            'make .cockpit/local a plain directory you can write, then run this command again')
    }
    if (plan.settings === undefined) return { kind: 'complete' }
    try {
        await writeClaudeLocalSettings(root, plan.settings.bytes)
        return { kind: 'complete' }
    } catch (error) {
        return grantRefusal(`${join(root, CLAUDE_LOCAL_SETTINGS)} could not be written: ${errorCause(error)}`, CLAUDE_LOCAL_SETTINGS,
            'make .claude a plain directory you can write, then run this command again')
    }
}

// Claude Code reads a project's `.claude/settings.json` only from the directory a session starts in, and
// `.claude/settings.local.json` also from the repository's top, so the guard registration is repeated
// there to bind a session started in a subdirectory. Measured 2026-11-13 with Claude Code 2.1.323 and the
// default setting sources: started one or two directories below the root, only the local file's hook ran,
// and a malformed twin of it was named from there; started at the root, a command registered identically
// in both files ran once, while two different commands both ran. A local file in a directory between the
// root and the session's was not read.
const CLAUDE_SETTINGS = '.claude/settings.json'

type HookEntry = Readonly<{ hooks: readonly Readonly<{ command?: unknown }>[] }> & Readonly<Record<string, unknown>>
const guardCommand = (hook: unknown) => plainObject(hook) && typeof hook.command === 'string'
    && hook.command.includes('/.cockpit/guards/bash-guard.sh') && hook.command.includes('--harness claudecode')
const hookEntries = (settings: unknown): readonly unknown[] | undefined => {
    if (!plainObject(settings)) return undefined
    const hooks = settings.hooks ?? {}
    if (!plainObject(hooks)) return undefined
    const entries = hooks.PreToolUse ?? []
    return Array.isArray(entries) ? entries : undefined
}
/** The guard's PreToolUse entries in Claude Code settings: each entry with a hook that runs the cockpit guard. */
function guardEntries(settings: unknown): readonly HookEntry[] {
    return (hookEntries(settings) ?? []).filter((entry): entry is HookEntry => plainObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some(guardCommand))
}

/**
 * Local settings carrying exactly the guard entries the committed settings register, beside everything
 * else a person keeps there; undefined when they already do, or a reason when the file is not settings
 * cockpit can add a hook to. An entry cockpit wrote before is replaced, never duplicated.
 */
export function mergeClaudeLocalGuard(current: unknown, wanted: readonly HookEntry[]): Readonly<{ bytes: string | null } | { reason: string }> | undefined {
    const object = current ?? {}
    const entries = hookEntries(object)
    // Claude Code drops a whole settings file it cannot load, so cockpit never rewrites one it cannot read either.
    if (!plainObject(object) || entries === undefined) return { reason: 'it is not a Claude Code settings object whose hooks.PreToolUse is a list' }
    const kept = entries.flatMap(entry => {
        if (!plainObject(entry) || !Array.isArray(entry.hooks)) return [entry]
        const hooks = entry.hooks.filter(hook => !guardCommand(hook))
        return hooks.length === entry.hooks.length ? [entry] : hooks.length ? [{ ...entry, hooks }] : []
    })
    const PreToolUse = [...kept, ...wanted]
    const { hooks: _hooks, ...others } = object
    const otherHooks = plainObject(object.hooks) ? Object.fromEntries(Object.entries(object.hooks).filter(([event]) => event !== 'PreToolUse')) : {}
    const nextHooks = PreToolUse.length ? { ...otherHooks, PreToolUse } : otherHooks
    const next = Object.keys(nextHooks).length ? { ...others, hooks: nextHooks } : others
    if (JSON.stringify(next) === JSON.stringify(object)) return undefined
    return { bytes: Object.keys(next).length ? `${JSON.stringify(next, null, 2)}\n` : null }
}

/**
 * The top of the repository holding the cockpit, when it is a directory above the cockpit root: Claude
 * Code reads local settings only from a session's own directory and that top, so a cockpit nested below
 * it registers the guard there too. Found as Git marks it, by the nearest `.git` entry at or above the root.
 */
function repositoryTopAbove(root: string): string | undefined {
    for (let directory = root; ; directory = dirname(directory)) {
        try { lstatSync(join(directory, '.git')); return directory === root ? undefined : realpathSync(directory) }
        catch (error) { if (!isMissing(error)) throw error }
        if (dirname(directory) === directory) return undefined
    }
}

/**
 * The guard entries for the repository top's local settings: each runs the guard only for a session that
 * started inside the cockpit below its root, and does nothing elsewhere in the repository, or at the
 * root, whose own settings register the guard.
 */
function gatedEntries(root: string, wanted: readonly HookEntry[]): readonly HookEntry[] {
    const gate = `C='${root.replaceAll("'", "'\\''")}'; case "\${CLAUDE_PROJECT_DIR:-$(pwd -P)}" in "$C"/*) ;; *) exit 0;; esac; `
    return wanted.map(entry => ({ ...entry, hooks: entry.hooks.map(hook => guardCommand(hook) ? { ...hook, command: gate + (hook as { command: string }).command } : hook) }))
}

/** The committed guard entries, and the local settings as read; a reason when either cannot be read. */
function claudeGuardFiles(root: string, settingsRoot = root): Readonly<{ wanted: readonly HookEntry[]; local: Readonly<{ value: unknown; bytes: string }> | undefined } | { reason: string }> {
    // A file that does not parse is no absent one: rewriting it would drop what a person keeps there.
    const committed = readLocalJson(join(root, CLAUDE_SETTINGS))
    if (committed && 'reason' in committed) return { reason: `${CLAUDE_SETTINGS} ${committed.reason}` }
    if (committed && committed.value === undefined) return { reason: `${CLAUDE_SETTINGS} is not valid JSON` }
    const localPath = join(settingsRoot, CLAUDE_LOCAL_SETTINGS)
    const local = readLocalJson(localPath)
    if (local && 'reason' in local) return { reason: `${localPath} ${local.reason}` }
    if (local && local.value === undefined) return { reason: `${localPath} is not valid JSON` }
    const wanted = guardEntries(committed?.value)
    return { wanted: settingsRoot === root ? wanted : gatedEntries(root, wanted), local }
}

/**
 * Repeats the committed guard registration in Claude Code's local settings at the cockpit root, and at
 * the repository's top when the cockpit lies below it, or takes cockpit's entry back when none is committed.
 */
export async function writeClaudeLocalGuard(root: string): Promise<Readonly<{ kind: 'complete' } | { kind: 'refusal'; message: string }>> {
    let top: string | undefined
    try { top = repositoryTopAbove(root) } catch (error) { return { kind: 'refusal', message: `the repository above ${root} could not be found: ${errorCause(error)}` } }
    for (const settingsRoot of top === undefined ? [root] : [root, top]) {
        const files = claudeGuardFiles(root, settingsRoot)
        if ('reason' in files) return { kind: 'refusal', message: files.reason }
        if (files.local === undefined && files.wanted.length === 0) continue
        const merged = mergeClaudeLocalGuard(files.local?.value, files.wanted)
        if (merged === undefined) continue
        if ('reason' in merged) return { kind: 'refusal', message: `${join(settingsRoot, CLAUDE_LOCAL_SETTINGS)} could not take the guard registration: ${merged.reason}` }
        try { await writeClaudeLocalSettings(settingsRoot, merged.bytes) }
        catch (error) { return { kind: 'refusal', message: `${join(settingsRoot, CLAUDE_LOCAL_SETTINGS)} could not be written: ${errorCause(error)}` } }
    }
    return { kind: 'complete' }
}

/** Doctor's finding when Claude Code sessions started below the cockpit root would run without the guard. */
export function inspectClaudeLocalGuard(root: string): readonly EnvironmentDiagnostic[] {
    let top: string | undefined
    try { top = repositoryTopAbove(root) } catch { top = undefined } // an unreadable parent leaves the root's own file to check
    return [root, ...top === undefined ? [] : [top]].flatMap(settingsRoot => inspectLocalGuardAt(root, settingsRoot))
}

function inspectLocalGuardAt(root: string, settingsRoot: string): readonly EnvironmentDiagnostic[] {
    const files = claudeGuardFiles(root, settingsRoot)
    const missing = (why: string): EnvironmentDiagnostic => ({ severity: 'warning',
        code: 'CLAUDE_LOCAL_HOOK_MISSING' satisfies typeof ENVIRONMENT_CODES.CLAUDE_LOCAL_HOOK_MISSING,
        message: `${why}; Claude Code reads ${CLAUDE_SETTINGS} only from the directory a session starts in, so a session started below the cockpit root runs without the guard`,
        // Code and fix are literals, so the diagnostic inventory captures the fix beside the code.
        target: join(settingsRoot, CLAUDE_LOCAL_SETTINGS), fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> in a terminal; if sync cannot read .claude/settings.local.json, make it a JSON object or remove it first' })
    const local = join(settingsRoot, CLAUDE_LOCAL_SETTINGS)
    if ('reason' in files) return [missing(`cockpit could not check the guard registration in ${local}: ${files.reason}`)]
    if (files.wanted.length === 0) return []
    if (plainObject(files.local?.value) && files.local.value.disableAllHooks === true) return [missing(`${local} sets disableAllHooks`)]
    const present = mergeClaudeLocalGuard(files.local?.value, files.wanted) === undefined
    return present ? [] : [missing(`${local} does not register the guard ${CLAUDE_SETTINGS} registers`)]
}

// Directories a session does not start in, and a bound on the walk: doctor reports, it does not prove.
const SETTINGS_WALK_SKIPPED = new Set(['node_modules', '.git'])
const SETTINGS_WALK_LIMIT = 20_000
const ROOT_AGENT_SETTINGS = /^(?:\.claude\/settings(?:\.local)?\.json|\.claude\/hooks\/.+|\.codex\/(?:config\.toml|hooks\.json)|\.mcp\.json|opencode\.jsonc?|\.opencode\/opencode\.jsonc?|\.opencode\/plugins?\/.+)$/

/**
 * Doctor's findings about agent tool settings that would switch the guard off: one below the cockpit
 * root, which a session started in that directory loads instead of the cockpit's, `disableAllHooks`
 * in any Claude Code settings file found, which stops every hook, the guard's included, and a guard
 * script, at the root or in a worktree kept below it, that does not match the digest sync recorded in
 * `home`, which the hook refuses to run.
 */
export function inspectAgentSettingsHazards(root: string, siblings: readonly string[] = [], home?: string): readonly EnvironmentDiagnostic[] {
    const nested: string[] = []
    const repositories: string[] = []
    const worktrees: string[] = []
    // Claude Code loads no hook from the cockpit's local settings for a session started at or below a `.git`
    // entry under the root, so each such entry other than a declared sibling or a worktree of this checkout,
    // which carries its own guard, is a place the guard does not reach.
    const common = gitCommonDirectory(root)
    const ownWorktree = (path: string) => {
        if (common === undefined) return false
        const named = /^gitdir: (.+)$/.exec(readSmallText(join(root, path)) ?? '')?.[1]
        return named !== undefined && resolve(dirname(join(root, path)), named).startsWith(`${common}/worktrees/`)
    }
    const claudeSettings = [CLAUDE_SETTINGS, CLAUDE_LOCAL_SETTINGS]
    let seen = 0
    const walk = (relative: string) => {
        let entries
        try { entries = readdirSync(join(root, relative), { withFileTypes: true }) } catch { return } // an unreadable directory holds nothing doctor can report
        for (const entry of entries) {
            if (++seen > SETTINGS_WALK_LIMIT) return
            const path = relative ? `${relative}/${entry.name}` : entry.name
            if (entry.name === '.git' && relative !== '' && !siblings.includes(join(root, relative))) {
                if (entry.isFile() && ownWorktree(path)) worktrees.push(relative)
                else repositories.push(path)
                continue
            }
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
                if (!SETTINGS_WALK_SKIPPED.has(entry.name) && !(relative === '' && entry.name === '.cockpit')) walk(path)
                continue
            }
            if (!nestedAgentConfiguration(foldGuardSpelling(`/${path}`), false)) continue
            // The cockpit root's own files are the generated ones, and its Claude settings are read below anyway.
            if (ROOT_AGENT_SETTINGS.test(path)) continue
            nested.push(path)
            if (/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(path)) claudeSettings.push(path)
        }
    }
    walk('')
    const findings: EnvironmentDiagnostic[] = []
    if (nested.length) findings.push({ severity: 'warning',
        code: 'AGENT_SETTINGS_NESTED' satisfies typeof ENVIRONMENT_CODES.AGENT_SETTINGS_NESTED,
        message: `agent tool settings below the cockpit root (${nested.slice(0, 10).join(', ')}${nested.length > 10 ? ', …' : ''}) load for a session started in that directory and can switch the guard off or start code there`,
        target: nested[0]!,
        fix: 'review each file a person did not intend, and remove it, or move what it holds into the cockpit root\'s settings and run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>' })
    if (repositories.length) findings.push({ severity: 'warning',
        code: 'AGENT_NESTED_REPOSITORY' satisfies typeof ENVIRONMENT_CODES.AGENT_NESTED_REPOSITORY,
        message: `Git repositories below the cockpit root (${repositories.slice(0, 10).join(', ')}${repositories.length > 10 ? ', …' : ''}) are neither declared siblings nor worktrees of this checkout; Claude Code loads no cockpit hook for a session started in one, so the guard does not run there`,
        target: repositories[0]!,
        fix: 'declare the repository as a [[sibling]], move it outside the cockpit root, or remove its .git entry; a person makes this change' })
    const disabled = claudeSettings.filter(path => { const read = readLocalJson(join(root, path)); return read !== undefined && !('reason' in read) && plainObject(read.value) && read.value.disableAllHooks === true })
    if (disabled.length) findings.push({ severity: 'warning',
        code: 'AGENT_HOOKS_DISABLED' satisfies typeof ENVIRONMENT_CODES.AGENT_HOOKS_DISABLED,
        message: `${disabled.join(', ')} set disableAllHooks, so Claude Code runs no hook, the cockpit guard included, for sessions that read ${disabled.length > 1 ? 'them' : 'it'}`,
        target: disabled[0]!,
        fix: 'remove disableAllHooks from the named Claude Code settings file; a person makes this change' })
    const guarded = (checkout: string) => { try { return lstatSync(join(checkout, GUARD_SCRIPT_PATH)).isFile() } catch { return false } } // an unreadable script is none
    if (!guarded(root)) return findings
    if (inspectGuardRecord(root, home) !== 'match') findings.push({ severity: 'error',
        code: 'GUARD_RECORD_MISMATCH' satisfies typeof ENVIRONMENT_CODES.GUARD_RECORD_MISMATCH,
        message: `${GUARD_SCRIPT_PATH} or ${GUARD_LOCAL_PATHS.identity} does not match the digest cockpit sync recorded for this cockpit, so every guarded call is held until a person runs sync`,
        target: GUARD_SCRIPT_PATH,
        fix: 'review what changed the guard script, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> in a terminal' })
    const unguarded = worktrees.filter(worktree => !guarded(join(root, worktree)) || inspectGuardRecord(realpathSync(join(root, worktree)), home) !== 'match')
    if (unguarded.length) findings.push({ severity: 'warning',
        code: 'GUARD_WORKTREE_UNGUARDED' satisfies typeof ENVIRONMENT_CODES.GUARD_WORKTREE_UNGUARDED,
        message: `worktrees below the cockpit root (${unguarded.slice(0, 10).join(', ')}${unguarded.length > 10 ? ', …' : ''}) hold no guard script, or one sync did not record, so a session started in one is held or unguarded`,
        target: unguarded[0]!,
        fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml in each worktree, or remove the worktree' })
    return findings
}

function readSmallText(path: string): string | undefined {
    try { const read = readBoundedFile(path, 4096); return read.kind === 'complete' ? read.bytes.toString('utf8').trim() : undefined }
    catch { return undefined } // an unreadable entry names no worktree, so it is reported
}

/** The Git directory that holds this checkout's worktrees: its own `.git` directory, or the one a linked worktree's `commondir` names. */
function gitCommonDirectory(root: string): string | undefined {
    const entry = join(root, '.git')
    try { if (lstatSync(entry).isDirectory()) return realpathSync(entry) } catch { return undefined } // no repository holds no worktrees
    const administrative = /^gitdir: (.+)$/.exec(readSmallText(entry) ?? '')?.[1]
    if (!administrative) return undefined
    const directory = resolve(root, administrative)
    const common = readSmallText(join(directory, 'commondir'))
    try { return realpathSync(common ? resolve(directory, common) : directory) } catch { return undefined } // a pruned worktree has none
}
