// Owns the read-only check of whether Codex will run cockpit's generated guard hook on this machine.
// Codex 0.165.0 skips a project hook until a person trusts it, and says nothing about the skip: a
// measured `codex exec` ran a push the guard refuses once the hook was trusted. Codex records trust
// per user as `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"] trusted_hash`, the SHA-256
// of a normalized hook identity, so this module recomputes that identity from the published
// hooks.json and compares. Linked worktrees source hooks from the main checkout, so matching the
// generated definitions there comes before checking their trust. It never writes either checkout
// or Codex's configuration and never reports a value from that configuration;
// anything it cannot read or reproduce is reported as unverified, not as trusted.
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse as parseToml, TomlError } from 'smol-toml'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'

import type { ENVIRONMENT_CODES, EnvironmentDiagnostic, ExecutionStep } from './contract.js'
import { RefusalError, tryParseJson, errorCause, hasErrorCode } from './contract.js'
import { observationEnvironment, resolveGitExecutable } from './executable.js'
import { mainCheckoutDirectory } from './git-observation.js'

const HOOKS_PATH = '.codex/hooks.json'
const MAX_FILE_BYTES = 4 * 1024 * 1024
// Codex's event keys. Events it runs without a matcher drop the matcher from the identity; the
// session-end and interrupt events normalize their timeout differently and are left unverified.
const EVENT_KEYS: Readonly<Record<string, string>> = Object.freeze({
    PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', PostToolUse: 'post_tool_use',
    PreCompact: 'pre_compact', PostCompact: 'post_compact', SessionStart: 'session_start',
    SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop', UserPromptSubmit: 'user_prompt_submit', Stop: 'stop',
})
const MATCHERLESS = new Set(['user_prompt_submit', 'stop'])
const HANDLER_KEYS = new Set(['type', 'command', 'commandWindows', 'timeout', 'async', 'statusMessage'])

interface CodexHook { readonly suffix: string; readonly hash: string }
type Trust = 'trusted' | 'untrusted' | 'modified' | 'disabled'

export interface CodexHookTrustInput {
    readonly root: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly timeoutMs: number
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted)
    if (!record(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}

/** The hooks Codex discovers in a hooks.json, keyed and hashed as Codex 0.165.0 does, or why not. */
function codexHooks(bytes: string): readonly CodexHook[] | string {
    const parsed = tryParseJson(bytes)
    if (parsed === undefined) return 'its hooks.json is not JSON'
    if (!record(parsed) || !record(parsed.hooks)) return 'its hooks.json has no hooks object'
    const hooks: CodexHook[] = []
    for (const [event, groups] of Object.entries(parsed.hooks)) {
        const key = EVENT_KEYS[event]
        if (!key) return `its hooks.json declares the ${event} event, whose trust identity cockpit does not reproduce`
        if (!Array.isArray(groups)) return `its ${event} entry is not a list`
        for (const [groupIndex, group] of groups.entries()) {
            if (!record(group) || !Array.isArray(group.hooks) || group.matcher !== undefined && typeof group.matcher !== 'string') {
                return `its ${event} group ${groupIndex} is malformed`
            }
            for (const [handlerIndex, handler] of group.hooks.entries()) {
                if (!record(handler) || handler.type !== 'command' || typeof handler.command !== 'string'
                    || Object.keys(handler).some(name => !HANDLER_KEYS.has(name))
                    || handler.timeout !== undefined && !Number.isSafeInteger(handler.timeout)
                    || handler.async !== undefined && typeof handler.async !== 'boolean'
                    || handler.statusMessage !== undefined && typeof handler.statusMessage !== 'string') {
                    return `its ${event} hook ${groupIndex}:${handlerIndex} has a shape whose trust identity cockpit does not reproduce`
                }
                // Codex hashes the handler after normalizing it: the timeout defaults to ten minutes and
                // the Windows command is dropped on other systems.
                const normalized = {
                    type: 'command', command: handler.command, timeout: Math.max(1, (handler.timeout as number | undefined) ?? 600),
                    async: handler.async ?? false, ...(handler.statusMessage === undefined ? {} : { statusMessage: handler.statusMessage }),
                }
                const identity = { event_name: key, hooks: [normalized],
                    ...(group.matcher === undefined || MATCHERLESS.has(key) ? {} : { matcher: group.matcher }) }
                hooks.push({ suffix: `${key}:${groupIndex}:${handlerIndex}`,
                    hash: `sha256:${createHash('sha256').update(JSON.stringify(sorted(identity))).digest('hex')}` })
            }
        }
    }
    return hooks
}

async function bounded(path: string): Promise<string | 'missing'> {
    try {
        const bytes = await readFile(path)
        if (bytes.byteLength > MAX_FILE_BYTES) throw new RefusalError(`${path} exceeds ${MAX_FILE_BYTES} bytes`)
        return bytes.toString('utf8')
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return 'missing'
        throw error
    }
}

function trustFor(states: Record<string, unknown>, source: string, hooks: readonly CodexHook[]): Trust {
    let trust: Trust = 'trusted'
    for (const hook of hooks) {
        const state = states[`${source}:${hook.suffix}`]
        if (!record(state) || state.trusted_hash === undefined) return 'untrusted'
        if (state.enabled === false) trust = 'disabled'
        else if (state.trusted_hash !== hook.hash && trust === 'trusted') trust = 'modified'
    }
    return trust
}

function warning(message: string): EnvironmentDiagnostic {
    return {
        severity: 'warning' as const,
        // Code and fix are literals, so the diagnostic inventory captures the fix beside the code and
        // the troubleshooting index repeats it. The message names the hook's path, and the printed
        // fix binds the configuration placeholder to the resolved path.
        code: 'CODEX_HOOK_UNTRUSTED' satisfies typeof ENVIRONMENT_CODES.CODEX_HOOK_UNTRUSTED,
        message,
        target: HOOKS_PATH,
        fix: 'if the hook source could not be verified, resolve the reported discovery failure first; otherwise a person runs codex -C <hook source directory> in a terminal (not codex exec), trusts the folder if asked, and chooses "Trust all and continue" when Codex shows "Hooks need review" (or enables and trusts the hook in its /hooks view); then run npx --no cockpit doctor --config <your cockpit.toml>',
    }
}

function sourceMismatch(source: string, expected: string, reason: string): readonly EnvironmentDiagnostic[] {
    return [{
        severity: 'warning',
        code: 'CODEX_HOOK_SOURCE_MISMATCH' satisfies typeof ENVIRONMENT_CODES.CODEX_HOOK_SOURCE_MISMATCH,
        message: `Codex discovers ${source} for this linked worktree, but ${reason}; it does not load the generated definitions in ${expected}, and trusting that worktree file cannot repair the discovery mismatch`,
        target: HOOKS_PATH,
        fix: 'have a person review and roll out the matching generated hooks in the original checkout through its normal change process; cockpit does not copy hooks or change that checkout; rerun npx --no cockpit doctor --config <your cockpit.toml>, then review and trust the reported source in interactive Codex',
    }]
}

/**
 * A warning when Codex will skip the generated guard hook on this machine, or when that cannot be
 * verified; nothing when every hook is trusted, no Codex hook is published, or Codex has never run
 * as this user.
 */
export async function inspectCodexHookTrust(input: CodexHookTrustInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>): Promise<readonly EnvironmentDiagnostic[]> {
    const root = resolve(input.root)
    let hooksPath = join(root, HOOKS_PATH)
    const unverified = (reason: string) => [warning(
        `cockpit could not verify whether Codex trusts the guard hook in ${hooksPath} (${reason}); Codex skips a project hook until a person trusts it, and then runs tool calls without the guard`)]
    let hooksBytes: string | 'missing'
    try { hooksBytes = await bounded(hooksPath) } catch (error) { return unverified(`reading it failed: ${errorCause(error)}`) }
    if (hooksBytes === 'missing') return []
    const hooks = codexHooks(hooksBytes)
    if (typeof hooks === 'string') return unverified(hooks)
    if (hooks.length === 0) return []
    const home = input.env.CODEX_HOME || (input.env.HOME ? join(input.env.HOME, '.codex') : undefined)
    if (!home) return unverified('neither CODEX_HOME nor HOME is set, so Codex\'s configuration cannot be found')
    // Every cockpit publishes the Codex hook, so a person who never runs Codex here saw this warning on
    // every check. Codex creates its home on first run; without one no Codex session can skip the hook.
    try { await stat(home) } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return []
        return unverified(`reading ${home} failed: ${errorCause(error)}`)
    }
    const search = observationEnvironment(input.env)
    if (search.state !== 'available') return unverified(`the hook source cannot be established: ${search.reason}`)
    const git = await resolveGitExecutable(search.env)
    if (git.state !== 'available') return unverified(`the hook source cannot be established: ${git.reason}`)
    let sourceRoot: string | undefined
    try {
        sourceRoot = await mainCheckoutDirectory({ executable: git.value, directory: root, timeoutMs: input.timeoutMs }, execute)
    } catch (error) { return unverified(`the hook source cannot be established: ${errorCause(error)}`) }
    if (!sourceRoot) return unverified('Git could not establish the original checkout hook source')
    let canonical: string
    try { canonical = await realpath(root) } catch (error) { return unverified(`resolving ${root} failed: ${errorCause(error)}`) }
    if (sourceRoot !== canonical) {
        const expected = hooksPath
        hooksPath = join(sourceRoot, HOOKS_PATH)
        let sourceBytes: string | 'missing'
        try { sourceBytes = await bounded(hooksPath) } catch (error) { return unverified(`reading the discovered source failed: ${errorCause(error)}`) }
        if (sourceBytes === 'missing') return sourceMismatch(hooksPath, expected, 'that source is missing')
        const sourceHooks = codexHooks(sourceBytes)
        if (typeof sourceHooks === 'string') return sourceMismatch(hooksPath, expected, sourceHooks)
        const identities = new Map(sourceHooks.map(hook => [hook.suffix, hook.hash]))
        if (identities.size !== hooks.length || hooks.some(hook => identities.get(hook.suffix) !== hook.hash)) {
            return sourceMismatch(hooksPath, expected, 'its hook definitions differ')
        }
    }
    const codexConfig = join(home, 'config.toml')
    let states: Record<string, unknown> = {}
    try {
        const bytes = await bounded(codexConfig)
        if (bytes !== 'missing') {
            const parsed = parseToml(bytes) as Record<string, unknown>
            const recorded = record(parsed.hooks) ? parsed.hooks.state : undefined
            if (recorded !== undefined && !record(recorded)) return unverified(`hooks.state in ${codexConfig} is not a table`)
            states = recorded ?? {}
        }
    } catch (error) {
        // smol-toml quotes the lines around a syntax error, and Codex's configuration can hold
        // credentials, so only the position is reported.
        if (error instanceof TomlError) return unverified(`${codexConfig} is not valid TOML at line ${error.line}, column ${error.column}`)
        return unverified(`reading ${codexConfig} failed: ${errorCause(error)}`)
    }
    // Codex keys trust by the hooks.json path as the session directory spells it, which may or may
    // not resolve symbolic links, so trust recorded under either spelling counts.
    const sources = sourceRoot === canonical ? [hooksPath, join(canonical, HOOKS_PATH)] : [hooksPath]
    const results = [...new Set(sources)].map(source => trustFor(states, source, hooks))
    if (results.includes('trusted')) return []
    const consequence = `a Codex session in ${root} skips it and runs tool calls without the guard; its hook source directory is ${sourceRoot}`
    const message = results.includes('disabled') ? `the guard hook in ${hooksPath} is disabled in ${codexConfig}, so ${consequence}`
        : results.includes('modified') ? `Codex trusted an earlier version of the guard hook in ${hooksPath}; until a person trusts the current one, ${consequence}`
            : `Codex has not trusted the guard hook in ${hooksPath} on this machine, so ${consequence}`
    return [warning(message)]
}
