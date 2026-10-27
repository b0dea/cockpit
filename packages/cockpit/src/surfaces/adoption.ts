/**
 * Owns the merge of a team's adopted harness settings file with cockpit's rendering of the same
 * path, and the refusals that stop an adopted file from switching off or bypassing the guard.
 *
 * It is pure: callers read the adopted copy and supply cockpit's rendered bytes. It does not
 * decide which files are adopted (cockpit.toml's `[[surfaces.adopted]]` rows do), and it never
 * writes; the generated application publishes the merged bytes as an ordinary whole-file surface.
 */
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

import { ADOPTED_SURFACE_ROOT, type AdoptableSurfacePath } from './contract.js'
import { composeHookSettings } from './render.js'

export const mechanism = {
    id: 'surface-adoption-merge',
    module: 'packages/cockpit/src/surfaces/adoption.ts',
    exports: ['adoptedCopyPath', 'inspectAdoptedSettings', 'mergeAdoptedSurface'],
} as const

export type AdoptionDiagnostic = Readonly<{ code: 'SURFACE_ADOPTION_REFUSED'; message: string; target: string }>
export type AdoptedSettingsInspection =
    | Readonly<{ kind: 'complete'; value: Record<string, unknown> }>
    | Readonly<{ kind: 'refusal'; diagnostic: AdoptionDiagnostic }>
export type AdoptedSurfaceMerge =
    | Readonly<{ kind: 'complete'; bytes: string }>
    | Readonly<{ kind: 'refusal'; diagnostic: AdoptionDiagnostic }>

// Every guard transport is published below this directory; an adopted hook that names it is
// re-registering or shadowing the guard rather than adding a team hook.
const GUARD_DIRECTORY = '.cockpit/guards/'

export function adoptedCopyPath(path: AdoptableSurfacePath): string {
    return `${ADOPTED_SURFACE_ROOT}/${path}`
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function refusal(file: string, key: string, reason: string): Extract<AdoptedSettingsInspection, { kind: 'refusal' }> {
    return { kind: 'refusal', diagnostic: { code: 'SURFACE_ADOPTION_REFUSED', target: `${file}#${key}`,
        message: `adopted settings in ${file} set \`${key}\`, which ${reason}; remove \`${key}\` from ${file} and re-run cockpit sync` } }
}

function parse(path: AdoptableSurfacePath, bytes: string, file: string): AdoptedSettingsInspection {
    let value: unknown
    try { value = path === '.codex/config.toml' ? parseToml(bytes) : JSON.parse(bytes) } catch (error) {
        return { kind: 'refusal', diagnostic: { code: 'SURFACE_ADOPTION_REFUSED', target: file,
            message: `${file} is not valid ${path === '.codex/config.toml' ? 'TOML' : 'JSON'} (${error instanceof Error ? error.message.split('\n', 1)[0] : 'unparseable'}); fix it and re-run cockpit sync` } }
    }
    if (!record(value)) return { kind: 'refusal', diagnostic: { code: 'SURFACE_ADOPTION_REFUSED', target: file,
        message: `${file} must hold one settings object at its root; fix it and re-run cockpit sync` } }
    return { kind: 'complete', value }
}

function guardHookReference(value: Record<string, unknown>, file: string): Extract<AdoptedSettingsInspection, { kind: 'refusal' }> | undefined {
    const hooks = value.hooks
    if (hooks === undefined) return undefined
    if (!record(hooks)) return refusal(file, 'hooks', 'must be an object of hook events for cockpit to keep its guard hook beside the team\'s')
    for (const [event, rows] of Object.entries(hooks)) {
        if (!Array.isArray(rows)) return refusal(file, `hooks.${event}`, 'must be a list of hook entries')
        if (JSON.stringify(rows).includes(GUARD_DIRECTORY)) {
            return refusal(file, `hooks.${event}`, 'registers or overrides cockpit\'s guard hook; cockpit adds that hook itself')
        }
    }
    return undefined
}

/**
 * Refuse, by key, everything in an adopted file that could switch off or route around the guard,
 * or that carries an authority cockpit declares elsewhere. Sources for each key:
 * - `disableAllHooks`: the guard evaluator names it as the switch that turns Claude's hook off.
 * - `permissions.defaultMode = "bypassPermissions"`: starts every Claude session with no prompts.
 * - `hooks.*` naming the guard transport: would re-register or shadow the guard hook (both
 *   restriction adapters register it as a PreToolUse hook in these files).
 * - `permissions.additionalDirectories`, `enabledMcpjsonServers`: written from the declared
 *   directory grants and approved MCP servers.
 * - `mcp_servers`: written from the approved MCP servers.
 * - `features.codex_hooks = false`: the generator treats it as Codex's hook feature switch.
 */
export function inspectAdoptedSettings(path: AdoptableSurfacePath, bytes: string, file: string = adoptedCopyPath(path)): AdoptedSettingsInspection {
    const parsed = parse(path, bytes, file)
    if (parsed.kind !== 'complete') return parsed
    const value = parsed.value
    if (path === '.claude/settings.json') {
        if (Object.hasOwn(value, 'disableAllHooks') && value.disableAllHooks !== false) {
            return refusal(file, 'disableAllHooks', 'switches off every hook, including cockpit\'s guard')
        }
        const permissions = value.permissions
        if (permissions !== undefined && !record(permissions)) return refusal(file, 'permissions', 'must be an object')
        if (permissions?.defaultMode === 'bypassPermissions') {
            return refusal(file, 'permissions.defaultMode', 'is "bypassPermissions" and starts every session with no permission prompts')
        }
        if (permissions && Object.hasOwn(permissions, 'additionalDirectories')) {
            return refusal(file, 'permissions.additionalDirectories', 'cockpit writes from the declared sibling directory grants; declare the directory as a sibling instead')
        }
        if (Object.hasOwn(value, 'enabledMcpjsonServers')) {
            return refusal(file, 'enabledMcpjsonServers', 'cockpit writes from the approved MCP servers; approve the server under [mcp] instead')
        }
    }
    if (path === '.codex/config.toml') {
        if (Object.hasOwn(value, 'mcp_servers')) {
            return refusal(file, 'mcp_servers', 'cockpit writes from the approved MCP servers; approve the server under [mcp] instead')
        }
        const features = value.features
        if (record(features) && Object.hasOwn(features, 'codex_hooks') && features.codex_hooks !== true) {
            return refusal(file, 'features.codex_hooks', 'switches off Codex hooks, including cockpit\'s guard')
        }
    }
    if (path !== '.codex/config.toml') {
        const hookRefusal = guardHookReference(value, file)
        if (hookRefusal) return hookRefusal
    }
    return parsed
}

function same(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

function owned(file: string, key: string) {
    return refusal(file, key, 'cockpit writes with a different value')
}

function strings(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Claude permission rules are unioned. Claude evaluates deny before allow, and the merge keeps that
 * true in the file as well: a rule cockpit denies never also appears as a team allow or ask.
 */
function mergePermissions(cockpit: unknown, adopted: unknown, file: string): Readonly<{ kind: 'complete'; value: Record<string, unknown> }> | ReturnType<typeof refusal> {
    const base = cockpit ?? {}
    const team = adopted ?? {}
    if (!record(base) || !record(team)) return refusal(file, 'permissions', 'must be an object')
    const result: Record<string, unknown> = { ...base }
    for (const key of ['allow', 'ask', 'deny'] as const) {
        if (base[key] !== undefined && !strings(base[key])) return refusal(file, `permissions.${key}`, 'cockpit could not read as a list of rules')
        if (team[key] !== undefined && !strings(team[key])) return refusal(file, `permissions.${key}`, 'must be a list of permission rules')
    }
    const denied = new Set(strings(base.deny) ? base.deny : [])
    for (const key of ['allow', 'ask', 'deny'] as const) {
        if (base[key] === undefined && team[key] === undefined) continue
        const rules = [...new Set([...(base[key] as readonly string[] | undefined ?? []), ...(team[key] as readonly string[] | undefined ?? [])])]
        result[key] = key === 'deny' ? rules : rules.filter(rule => !denied.has(rule))
    }
    for (const [key, value] of Object.entries(team)) {
        if (key === 'allow' || key === 'ask' || key === 'deny') continue
        if (Object.hasOwn(result, key) && !same(result[key], value)) return owned(file, `permissions.${key}`)
        result[key] = value
    }
    return { kind: 'complete', value: result }
}

/** Tables merge key by key; any value cockpit also writes must match it exactly. */
function mergeTables(cockpit: Record<string, unknown>, adopted: Record<string, unknown>, file: string, prefix = ''): Readonly<{ kind: 'complete'; value: Record<string, unknown> }> | ReturnType<typeof refusal> {
    const result: Record<string, unknown> = { ...cockpit }
    for (const [key, value] of Object.entries(adopted)) {
        const name = prefix === '' ? key : `${prefix}.${key}`
        if (!Object.hasOwn(result, key)) {
            result[key] = value
            continue
        }
        const current = result[key]
        if (record(current) && record(value)) {
            const merged = mergeTables(current, value, file, name)
            if (merged.kind !== 'complete') return merged
            result[key] = merged.value
        } else if (!same(current, value)) return owned(file, name)
    }
    return { kind: 'complete', value: result }
}

/**
 * Render one adopted harness settings file: the team's keys plus cockpit's. Hooks follow the same
 * composition rule as two cockpit producers of one file; Claude permission rules are unioned with
 * cockpit's deny kept authoritative; any other key is the team's unless cockpit writes it, and then
 * the two must agree.
 */
export function mergeAdoptedSurface(path: AdoptableSurfacePath, adoptedBytes: string, cockpitBytes: string | undefined): AdoptedSurfaceMerge {
    const file = adoptedCopyPath(path)
    const inspected = inspectAdoptedSettings(path, adoptedBytes, file)
    if (inspected.kind !== 'complete') return inspected
    if (cockpitBytes === undefined) return { kind: 'complete', bytes: adoptedBytes }
    const rendered = parse(path, cockpitBytes, path)
    if (rendered.kind !== 'complete') return { kind: 'refusal', diagnostic: { code: 'SURFACE_ADOPTION_REFUSED', target: path,
        message: `cockpit's rendering of ${path} could not be read for merging` } }
    const adopted = inspected.value
    const cockpit = rendered.value
    if (path === '.codex/config.toml') {
        const merged = mergeTables(cockpit, adopted, file)
        return merged.kind === 'complete' ? { kind: 'complete', bytes: stringifyToml(merged.value) } : merged
    }
    let base = cockpit
    let team = adopted
    if (path === '.claude/settings.json') {
        const permissions = mergePermissions(cockpit.permissions, adopted.permissions, file)
        if (permissions.kind !== 'complete') return permissions
        const { permissions: _teamPermissions, ...rest } = adopted
        base = { ...cockpit, permissions: permissions.value }
        team = rest
    }
    const composed = composeHookSettings([base, team])
    if (composed.kind !== 'complete') return composed.reason === 'divergent' ? owned(file, composed.key)
        : refusal(file, composed.key, 'is not shaped as a hook registration')
    return { kind: 'complete', bytes: `${JSON.stringify(composed.value, null, 2)}\n` }
}
