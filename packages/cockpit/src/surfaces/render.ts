import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

import { snapshotGeneratedJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { CustomHarness, type CustomHarness as CustomHarnessValue } from '../schema.js'
import type { SurfaceFeature, SurfaceTarget } from './contract.js'
import type { SurfaceGenerationOutcome, SurfaceGenerationWarning } from './generator-adapter.js'
import type { SurfaceMergeResult } from './merge.js'
import type { McpCollectionOutcome } from './mcp.js'
import type { ProjectionPlanResult } from './projection.js'
import type { RestrictionExpansionResult } from './restrictions.js'
import { stripDevelopmentMarkers } from './development-markers.js'
import {
    captureOpenCodeRootMembers,
    classifySurfaceOwnership,
    type OpenCodeRootMember,
    type SurfaceDesiredEntry,
    type SurfaceDiagnostic,
} from './ownership.js'

export const mechanism = {
    id: 'surface-render',
    module: 'packages/cockpit/src/surfaces/render.ts',
    exports: ['surfaceModelSha256', 'renderSurfaceSet', 'composeHookSettings'],
} as const

export type SurfaceInputEvidence =
    | Readonly<{ kind: 'guide'; root: string; path: string; sha256: string; identity: string }>
    | Readonly<{ kind: 'mcp'; root: string; path: string; sha256: string; identity: string }>
    | Readonly<{
          kind: 'custom-harness'; harness: string; feature: SurfaceFeature; state: 'enforced' | 'instructed'; measuredOn: string
          module: string; export: string; sourceSha256: string; resultSha256: string
      }>

export interface NativeSurfaceFragment {
    readonly target: SurfaceTarget
    readonly path: string
    readonly baseSha256: string
    readonly bytes: string
    readonly sha256: string
}

export interface CustomSurfaceReceipt {
    readonly harness: string
    readonly feature: SurfaceFeature
    readonly state: 'enforced' | 'instructed'
    readonly measuredOn: string
    readonly module: string
    readonly export: string
    readonly sourceSha256: string
    readonly resultSha256: string
    readonly files: readonly Readonly<{ path: string; bytes: string; sha256: string; scope: 'always' | 'scoped' }>[]
}

export type SurfaceRenderResult =
    | Readonly<{ kind: 'complete'; entries: readonly SurfaceDesiredEntry[]; inputs: readonly SurfaceInputEvidence[]; warnings: readonly SurfaceGenerationWarning[] }>
    | Readonly<{ kind: 'refusal'; diagnostic: SurfaceDiagnostic }>

interface Contribution {
    readonly harnesses: readonly string[]
    readonly scope: 'always' | 'scoped'
    readonly capability: 'enforced' | 'instructed'
    readonly bytes: string
}

export interface NativeFragmentSet {
    readonly modelSha256: string
    readonly fragments: readonly NativeSurfaceFragment[]
}

export interface SurfaceRenderInput {
    readonly configuredHarnesses: readonly string[]
    readonly merge: Extract<SurfaceMergeResult, { kind: 'complete' }>
    readonly generated: Extract<SurfaceGenerationOutcome, { kind: 'complete' }>
    readonly projection: Extract<ProjectionPlanResult, { kind: 'complete' }>
    readonly mcp: Extract<McpCollectionOutcome, { kind: 'complete' }>
    readonly restrictions: Extract<RestrictionExpansionResult, { kind: 'complete' }>
    readonly nativeMcp: NativeFragmentSet
    readonly nativeGrants: NativeFragmentSet
    readonly browser: unknown | null
    readonly browserReference: string | null
    readonly testing: unknown | null
    readonly customHarnesses: readonly CustomHarnessValue[]
    readonly customReceipts: readonly CustomSurfaceReceipt[]
    readonly sourceEvidence: readonly Extract<SurfaceInputEvidence, { kind: 'guide' | 'mcp' }>[]
}

const SHA256 = /^[a-f0-9]{64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const MARKDOWN_PATHS = new Set(['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'])
const BUILT_INS = new Set<SurfaceTarget>(['claudecode', 'codexcli', 'opencode'])

function object(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: JsonSnapshotObject, required: readonly string[]): boolean {
    const keys = Object.keys(value).sort()
    const expected = [...required].sort()
    return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

export function surfaceModelSha256(value: unknown): string | undefined {
    const captured = snapshotGeneratedJson(value)
    return captured === undefined ? undefined : digest(JSON.stringify(captured))
}

function refuse(code: SurfaceDiagnostic['code'], message: string, target?: string): SurfaceRenderResult {
    return Object.freeze({ kind: 'refusal', diagnostic: Object.freeze({ code, message, ...(target === undefined ? {} : { target }) }) })
}

function safePath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.startsWith('/')
        && !/^[a-z]:[/\\]/i.test(value) && !/[\\\x00-\x1f\x7f]/.test(value)
        && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !['.git', 'internal', 'node_modules'].includes(part))
}

function validFileFields(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return object(value) && safePath(value.path)
        && typeof value.bytes === 'string' && Buffer.byteLength(value.bytes) <= 65_536
        && typeof value.sha256 === 'string' && value.sha256 === digest(value.bytes)
}

function validFile(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return object(value) && exact(value, ['path', 'bytes', 'sha256']) && validFileFields(value)
}

function validEvidence(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return object(value) && (value.kind === 'guide' || value.kind === 'mcp')
        && exact(value, ['kind', 'root', 'path', 'sha256', 'identity'])
        && typeof value.root === 'string' && isAbsolute(value.root) && typeof value.path === 'string' && value.path.length > 0
        && typeof value.identity === 'string' && value.identity.length > 0
        && typeof value.sha256 === 'string' && SHA256.test(value.sha256)
}

function sorted(values: Iterable<string>): readonly [string, ...string[]] | undefined {
    const result = [...new Set(values)].sort()
    return result.length === 0 ? undefined : result as [string, ...string[]]
}

function weakest(values: readonly ('enforced' | 'instructed')[]): 'enforced' | 'instructed' {
    return values.includes('instructed') ? 'instructed' : 'enforced'
}

function sharedScope(contributions: readonly Contribution[]): 'always' | 'scoped' | undefined {
    const scopes = new Set(contributions.map(contribution => contribution.scope))
    return scopes.size === 1 ? contributions[0]?.scope : undefined
}

function frontmatter(base: string, fragment: string): string | undefined {
    if (!base.startsWith('---\n')) return undefined
    const close = base.indexOf('\n---\n', 4)
    if (close < 0 || !fragment.endsWith('\n')) return undefined
    const key = fragment.startsWith('disallowedTools:') ? 'disallowedTools' : fragment.startsWith('permission:\n') ? 'permission' : undefined
    if (!key || new RegExp(`^${key}:`, 'm').test(base.slice(4, close))) return undefined
    return `${base.slice(0, close)}\n${fragment}${base.slice(close + 1)}`
}

export type HookSettingsComposition =
    | Readonly<{ kind: 'complete'; value: Record<string, unknown> }>
    | Readonly<{ kind: 'refusal'; key: string; reason: 'malformed' | 'divergent' }>

/**
 * The composition rule for a hook-registration settings file with several producers: every
 * PreToolUse row is kept once, and every other top-level key and hook event must agree exactly.
 * A refusal names the key so the producer that disagrees can be found.
 */
export function composeHookSettings(values: readonly unknown[]): HookSettingsComposition {
    const result: Record<string, unknown> = {}
    const hookEvents: Record<string, unknown> = {}
    const rows: unknown[] = []
    const refusal = (key: string, reason: 'malformed' | 'divergent'): HookSettingsComposition => ({ kind: 'refusal', key, reason })
    for (const parsed of values) {
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return refusal('(root)', 'malformed')
        const value = parsed as Record<string, unknown>
        const hooks = value.hooks
        if (hooks !== undefined && (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks))) return refusal('hooks', 'malformed')
        const pre = hooks === undefined ? [] : (hooks as Record<string, unknown>).PreToolUse ?? []
        if (!Array.isArray(pre)) return refusal('hooks.PreToolUse', 'malformed')
        rows.push(...pre)
        for (const [key, item] of Object.entries(value)) {
            if (key === 'hooks') continue
            if (Object.hasOwn(result, key) && JSON.stringify(result[key]) !== JSON.stringify(item)) return refusal(key, 'divergent')
            result[key] = item
        }
        for (const [key, item] of Object.entries(hooks as Record<string, unknown> | undefined ?? {})) {
            if (key === 'PreToolUse') continue
            if (Object.hasOwn(hookEvents, key) && JSON.stringify(hookEvents[key]) !== JSON.stringify(item)) return refusal(`hooks.${key}`, 'divergent')
            hookEvents[key] = item
        }
    }
    const unique = [...new Map(rows.map(row => [JSON.stringify(row), row])).values()]
    result.hooks = { ...hookEvents, PreToolUse: unique }
    return { kind: 'complete', value: result }
}

function hookJson(contributions: readonly Contribution[]): string | undefined {
    const values: unknown[] = []
    for (const contribution of contributions) {
        try { values.push(JSON.parse(contribution.bytes)) } catch { return undefined }
    }
    const composed = composeHookSettings(values)
    return composed.kind === 'complete' ? `${JSON.stringify(composed.value, null, 2)}\n` : undefined
}

function customReceipts(
    harnesses: readonly CustomHarnessValue[],
    value: JsonSnapshot | undefined,
): { readonly contributions: readonly { receipt: CustomSurfaceReceipt; file: CustomSurfaceReceipt['files'][number] }[]; readonly evidence: readonly SurfaceInputEvidence[] } | undefined {
    if (!Array.isArray(value) || value.length > 384) return undefined
    const available = new Map<string, CustomHarnessValue['capabilities'][number]>()
    for (const harness of harnesses) for (const capability of harness.capabilities) {
        if (capability.state !== 'unavailable') available.set(`${harness.name}\0${capability.feature}`, capability)
    }
    const seen = new Set<string>()
    const contributions: Array<{ receipt: CustomSurfaceReceipt; file: CustomSurfaceReceipt['files'][number] }> = []
    const evidence: SurfaceInputEvidence[] = []
    for (const candidate of value) {
        if (!object(candidate) || !exact(candidate, ['harness', 'feature', 'state', 'measuredOn', 'module', 'export', 'sourceSha256', 'resultSha256', 'files'])
            || typeof candidate.harness !== 'string' || typeof candidate.feature !== 'string'
            || candidate.state !== 'enforced' && candidate.state !== 'instructed' || typeof candidate.measuredOn !== 'string' || !DATE.test(candidate.measuredOn)
            || typeof candidate.module !== 'string' || typeof candidate.export !== 'string'
            || typeof candidate.sourceSha256 !== 'string' || !SHA256.test(candidate.sourceSha256)
            || typeof candidate.resultSha256 !== 'string' || !SHA256.test(candidate.resultSha256)
            || !Array.isArray(candidate.files) || candidate.files.length === 0) return undefined
        const identity = `${candidate.harness}\0${candidate.feature}`
        const declaration = available.get(identity)
        if (!declaration || seen.has(identity) || declaration.state !== candidate.state || declaration.measured_on !== candidate.measuredOn
            || declaration.mechanism.module !== candidate.module || declaration.mechanism.export !== candidate.export) return undefined
        const files: CustomSurfaceReceipt['files'][number][] = []
        for (const file of candidate.files) {
            if (!object(file) || !exact(file, ['path', 'bytes', 'sha256', 'scope']) || !validFileFields(file)
                || file.scope !== 'always' && file.scope !== 'scoped') return undefined
            files.push(file as unknown as CustomSurfaceReceipt['files'][number])
        }
        if (surfaceModelSha256(files) !== candidate.resultSha256) return undefined
        const receipt = candidate as unknown as CustomSurfaceReceipt
        for (const file of files) contributions.push({ receipt, file })
        evidence.push({ kind: 'custom-harness', harness: receipt.harness, feature: receipt.feature, state: receipt.state,
            measuredOn: receipt.measuredOn, module: receipt.module, export: receipt.export,
            sourceSha256: receipt.sourceSha256, resultSha256: receipt.resultSha256 })
        seen.add(identity)
    }
    if ([...available.keys()].some(identity => !seen.has(identity))) return undefined
    return { contributions, evidence }
}

function nativeFragments(value: JsonSnapshot | undefined, expectedDigest: string, targets: ReadonlySet<string>): readonly NativeSurfaceFragment[] | undefined {
    if (!object(value) || !exact(value, ['modelSha256', 'fragments']) || value.modelSha256 !== expectedDigest || !Array.isArray(value.fragments)) return undefined
    const result: NativeSurfaceFragment[] = []
    const seen = new Set<string>()
    for (const fragment of value.fragments) {
        if (!object(fragment) || !exact(fragment, ['target', 'path', 'baseSha256', 'bytes', 'sha256'])
            || typeof fragment.target !== 'string' || !BUILT_INS.has(fragment.target as SurfaceTarget) || !targets.has(fragment.target)
            || typeof fragment.baseSha256 !== 'string' || !SHA256.test(fragment.baseSha256)
            || !validFileFields(fragment) || seen.has(fragment.target)) return undefined
        seen.add(fragment.target)
        result.push(fragment as unknown as NativeSurfaceFragment)
    }
    return seen.size === targets.size ? result : undefined
}

function mergeNamedObject(left: unknown, right: unknown, replace?: string): Record<string, unknown> | undefined {
    const first = snapshotGeneratedJson(left)
    const second = snapshotGeneratedJson(right)
    if (!object(first) || !object(second)) return undefined
    const merged: Record<string, unknown> = { ...first }
    for (const [key, value] of Object.entries(second)) {
        if (Object.hasOwn(merged, key) && key !== replace && JSON.stringify(merged[key]) !== JSON.stringify(value)) return undefined
        merged[key] = value
    }
    return merged
}

function mergeBrowserMcp(path: string, base: string, browser: string): string | undefined {
    try {
        const first = snapshotGeneratedJson(path === '.codex/config.toml' ? parseToml(base) : JSON.parse(base))
        const second = snapshotGeneratedJson(path === '.codex/config.toml' ? parseToml(browser) : JSON.parse(browser))
        if (!object(first) || !object(second)) return undefined
        const key = path === '.mcp.json' ? 'mcpServers' : path === '.codex/config.toml' ? 'mcp_servers' : path === 'opencode.jsonc' ? 'mcp' : undefined
        if (!key) return undefined
        const browserMembers = second[key]
        if (!object(browserMembers) || Object.keys(browserMembers).some(name => name !== 'playwright')) return undefined
        const members = mergeNamedObject(first[key], browserMembers, 'playwright')
        if (!members || !Object.hasOwn(members, 'playwright')) return undefined
        const additions = { ...second } as Record<string, unknown>
        delete additions[key]
        const merged = mergeNamedObject(first, additions)
        if (merged) merged[key] = members
        return merged ? path === '.codex/config.toml' ? stringifyToml(merged) : `${JSON.stringify(merged, null, 2)}\n` : undefined
    } catch { return undefined }
}

export function renderSurfaceSet(input: unknown): SurfaceRenderResult {
    const captured = snapshotGeneratedJson(input)
    const required = ['configuredHarnesses', 'merge', 'generated', 'projection', 'mcp', 'restrictions', 'instructions', 'nativeMcp', 'nativeGrants', 'browser', 'browserReference', 'browserRunner', 'testing', 'customHarnesses', 'customReceipts', 'sourceEvidence']
    if (!object(captured) || !exact(captured, required) || !Array.isArray(captured.configuredHarnesses)
        || !Array.isArray(captured.customHarnesses) || !Array.isArray(captured.sourceEvidence)
        || !object(captured.merge) || captured.merge.kind !== 'complete' || !Array.isArray(captured.merge.surfaces)
        || !Array.isArray(captured.merge.overrides) || !Array.isArray(captured.merge.findings)
        || !object(captured.generated) || !exact(captured.generated, ['kind', 'status', 'diagnostics', 'mechanism', 'files', ...(Object.hasOwn(captured.generated, 'warnings') ? ['warnings'] : [])])
        || captured.generated.kind !== 'complete' || captured.generated.status !== 0 || !Array.isArray(captured.generated.diagnostics)
        || captured.generated.diagnostics.length !== 0 || !object(captured.generated.mechanism)
        || !exact(captured.generated.mechanism, ['package', 'version', 'role']) || captured.generated.mechanism.package !== 'rulesync'
        || captured.generated.mechanism.version !== '40.2.0' || captured.generated.mechanism.role !== 'spelling'
        || !Array.isArray(captured.generated.files)
        || !object(captured.projection) || captured.projection.kind !== 'complete' || !Array.isArray(captured.projection.links)
        || !Array.isArray(captured.projection.native) || !Array.isArray(captured.projection.grants)
        || !object(captured.mcp) || captured.mcp.kind !== 'complete' || !object(captured.mcp.result)
        || !Array.isArray(captured.mcp.result.servers) || !Array.isArray(captured.mcp.result.wrappers) || !Array.isArray(captured.mcp.result.harnesses)
        || !object(captured.restrictions) || captured.restrictions.kind !== 'complete' || !validFile(captured.restrictions.sharedGuard)
        || !Array.isArray(captured.restrictions.targets)) return refuse('SURFACE_INPUT_INVALID', 'surface render requires exact accepted leaf results')
    const warnings = Object.hasOwn(captured.generated, 'warnings') ? captured.generated.warnings : []
    const generatedFiles = captured.generated.files
    let warningBytes = 0
    if (!Array.isArray(warnings) || warnings.length > 16 || warnings.some(warning => {
        if (!object(warning) || !exact(warning, ['severity', 'code', 'target', 'path', 'message'])
            || warning.severity !== 'warning' || warning.code !== 'SURFACE_GENERATOR_TRUST_WARNING'
            || warning.target !== 'claudecode' || warning.path !== '.claude/settings.json'
            || typeof warning.message !== 'string' || warning.message.length === 0
            || /[\u0000-\u001f\u007f]/u.test(warning.message)) return true
        const bytes = Buffer.byteLength(warning.message, 'utf8')
        warningBytes += bytes
        return bytes > 4096 || warningBytes > 16384
            || !generatedFiles.some(file => object(file) && file.target === warning.target && file.path === warning.path)
    })) return refuse('SURFACE_INPUT_INVALID', 'generator trust warnings must be bounded and name an emitted native settings file')
    const configured = captured.configuredHarnesses
    if (configured.length === 0 || configured.some((value, index) => typeof value !== 'string' || index > 0 && configured[index - 1]! >= value)) {
        return refuse('SURFACE_INPUT_INVALID', 'configured harness identities must be sorted and unique')
    }
    const configuredSet = new Set(configured as readonly string[])
    const parsedHarnesses = CustomHarness.array().safeParse(captured.customHarnesses)
    if (!parsedHarnesses.success || parsedHarnesses.data.some(harness => !configuredSet.has(harness.name))
        || [...BUILT_INS].some(target => !configuredSet.has(target))
        || configuredSet.size !== BUILT_INS.size + parsedHarnesses.data.length) return refuse('SURFACE_INPUT_INVALID', 'custom and built-in harness identities do not match the configured set')
    const custom = customReceipts(parsedHarnesses.data, captured.customReceipts)
    if (!custom) return refuse('SURFACE_INPUT_INVALID', 'custom capability receipt is missing or does not match its authenticated declaration')
    const browser = captured.browser === null ? null : object(captured.browser)
        && exact(captured.browser, ['rows', 'files', 'mcp', 'probes', 'clients', 'graderBrowserAccess'])
        && captured.browser.graderBrowserAccess === 'retained' && Array.isArray(captured.browser.rows)
        && Array.isArray(captured.browser.files) && Array.isArray(captured.browser.probes) && Array.isArray(captured.browser.clients)
        && object(captured.browser.mcp) ? captured.browser : undefined
    if (browser === undefined || (browser === null) !== (captured.browserReference === null)
        || captured.browserReference !== null && (typeof captured.browserReference !== 'string'
            || Buffer.byteLength(captured.browserReference) === 0 || Buffer.byteLength(captured.browserReference) > 65_536)) {
        return refuse('SURFACE_INPUT_INVALID', 'browser projection and authenticated reference must be paired bounded inputs')
    }
    const browserRunner = captured.browserRunner === null ? null : validFile(captured.browserRunner)
        && captured.browserRunner.path === 'scripts/browser-runner.sh' ? captured.browserRunner : undefined
    if (browserRunner === undefined) return refuse('SURFACE_INPUT_INVALID', 'browser runner asset must be a bounded authenticated input')
    if (browser) {
        const browserMcp = browser.mcp
        const browserServers = object(browserMcp) && browserMcp.kind === 'complete' && object(browserMcp.result)
            && Array.isArray(browserMcp.result.servers) ? browserMcp.result.servers : undefined
        const projectedPlaywright = browserServers?.length === 1 && object(browserServers[0]) && browserServers[0].name === 'playwright'
            ? browserServers[0] : undefined
        const sourcePlaywright = captured.mcp.result.servers.find(server => object(server) && server.name === 'playwright')
        const unavailable = browserServers?.length === 0 && !sourcePlaywright
            && Array.isArray(browser.rows) && Array.isArray(browser.files)
            && browser.rows.every(row => object(row) && (row.transport !== 'mcp'
                || row.declaration === 'unavailable' && row.callable === 'unavailable'))
            && browser.files.every(row => object(row) && !['.mcp.json', '.codex/config.toml', 'opencode.jsonc'].includes(String(row.path)))
        if (!unavailable && (!projectedPlaywright || !sourcePlaywright || JSON.stringify(projectedPlaywright) !== JSON.stringify(sourcePlaywright))) {
            return refuse('SURFACE_INPUT_INVALID', 'browser MCP projection is not bound to the accepted Playwright declaration')
        }
    }
    const testing = captured.testing === null ? null : object(captured.testing)
        && exact(captured.testing, ['tierGuide', 'nativeHooks']) && object(captured.testing.tierGuide)
        && exact(captured.testing.tierGuide, ['kind', 'bytes', 'lines', 'costs'])
        && captured.testing.tierGuide.kind === 'complete' && typeof captured.testing.tierGuide.bytes === 'string'
        && Buffer.byteLength(captured.testing.tierGuide.bytes) <= 65_536 && object(captured.testing.nativeHooks)
        ? captured.testing : undefined
    if (testing === undefined) return refuse('SURFACE_INPUT_INVALID', 'testing projection must be an exact bounded accepted leaf result')
    const tierGuide = testing && object(testing.tierGuide) ? testing.tierGuide : null
    const nativeHooks = testing && object(testing.nativeHooks) ? testing.nativeHooks : null
    if (testing && (!tierGuide || !nativeHooks)) return refuse('SURFACE_INPUT_INVALID', 'testing projection must retain its validated objects')
    if (tierGuide && (typeof tierGuide.bytes !== 'string' || typeof tierGuide.lines !== 'number' || !Number.isSafeInteger(tierGuide.lines) || tierGuide.lines < 1
        || tierGuide.lines !== (tierGuide.bytes as string).trimEnd().split('\n').length
        || !Array.isArray(tierGuide.costs) || tierGuide.costs.length !== BUILT_INS.size
        || tierGuide.costs.some(cost => !object(cost) || !exact(cost, ['target', 'status', 'metric', 'value', 'conditionalValue', 'cap', 'measuredOn', 'provenance', 'scopeSemantics'])
            || typeof cost.target !== 'string' || !BUILT_INS.has(cost.target as SurfaceTarget) || cost.status !== 'within_cap'
            || cost.metric !== 'lines' || typeof cost.value !== 'number' || !Number.isSafeInteger(cost.value) || cost.value < 0
            || typeof cost.conditionalValue !== 'number' || !Number.isSafeInteger(cost.conditionalValue) || cost.conditionalValue < 0
            || typeof cost.cap !== 'number' || !Number.isSafeInteger(cost.cap) || cost.cap < cost.value || typeof cost.measuredOn !== 'string' || !DATE.test(cost.measuredOn)
            || typeof cost.provenance !== 'string' || cost.provenance.length === 0
            || cost.scopeSemantics !== 'conditional' && cost.scopeSemantics !== 'full')
        || new Set(tierGuide.costs.map(cost => object(cost) ? cost.target : undefined)).size !== BUILT_INS.size)) {
        return refuse('SURFACE_INPUT_INVALID', 'testing tier guide lost its bounded load-cost proof')
    }

    if (captured.instructions !== null && (typeof captured.instructions !== 'string' || captured.instructions.length === 0
        || Buffer.byteLength(captured.instructions) > 65_536)) {
        return refuse('SURFACE_INPUT_INVALID', 'consumer instructions must be absent or a bounded non-empty string')
    }

    const evidence = captured.sourceEvidence.length <= 512 && captured.sourceEvidence.every(validEvidence)
        && new Set(captured.sourceEvidence.map(row => JSON.stringify(row))).size === captured.sourceEvidence.length
        ? captured.sourceEvidence as unknown as SurfaceInputEvidence[] : undefined
    if (!evidence) return refuse('SURFACE_INPUT_INVALID', 'guide and MCP evidence must be authenticated bounded data')
    for (const link of captured.projection.links) {
        if (!object(link) || typeof link.sourceGuidePath !== 'string' || typeof link.sourceContentSha256 !== 'string'
            || typeof link.sourceContentIdentity !== 'string' || !evidence.some(row => row.kind === 'guide' && row.path === link.sourceGuidePath
                && row.sha256 === link.sourceContentSha256 && row.identity === link.sourceContentIdentity)) {
            return refuse('SURFACE_INPUT_INVALID', 'projection guide output is not bound to matching evidence')
        }
    }
    for (const server of captured.mcp.result.servers) {
        if (!object(server) || !Array.isArray(server.sources)) return refuse('SURFACE_INPUT_INVALID', 'MCP result is malformed')
        for (const source of server.sources) if (!object(source) || typeof source.path !== 'string' || typeof source.sha256 !== 'string'
            || !evidence.some(row => row.kind === 'mcp' && row.path === source.path && row.sha256 === source.sha256)) {
            return refuse('SURFACE_INPUT_INVALID', 'MCP output is not bound to matching source evidence')
        }
    }

    const mcpTargets = new Set<string>()
    for (const harness of captured.mcp.result.harnesses) {
        if (!object(harness) || typeof harness.target !== 'string' || !BUILT_INS.has(harness.target as SurfaceTarget)
            || !configuredSet.has(harness.target) || mcpTargets.has(harness.target)) return refuse('SURFACE_INPUT_INVALID', 'MCP harness output is malformed')
        mcpTargets.add(harness.target)
    }
    const mcpModelDigest = surfaceModelSha256(captured.mcp.result)
    if (!mcpModelDigest) return refuse('SURFACE_BOUNDS', 'MCP model cannot be captured for native binding')
    const mcpNative = captured.mcp.result.servers.length === 0 && object(captured.nativeMcp)
        && captured.nativeMcp.modelSha256 === mcpModelDigest && Array.isArray(captured.nativeMcp.fragments) && captured.nativeMcp.fragments.length === 0
        ? [] : nativeFragments(captured.nativeMcp, mcpModelDigest, mcpTargets)
    if (!mcpNative) return refuse('SURFACE_INPUT_INVALID', 'nonempty MCP model requires exact native fragments bound to the same approvals')
    const grantTargets = new Set<string>()
    for (const grant of captured.projection.grants) if (object(grant) && typeof grant.target === 'string') grantTargets.add(grant.target)
    const grantsDigest = surfaceModelSha256(captured.projection.grants)
    if (!grantsDigest) return refuse('SURFACE_BOUNDS', 'directory grants cannot be captured for native binding')
    const grantNative = captured.projection.grants.length === 0 && object(captured.nativeGrants)
        && captured.nativeGrants.modelSha256 === grantsDigest && Array.isArray(captured.nativeGrants.fragments) && captured.nativeGrants.fragments.length === 0
        ? [] : nativeFragments(captured.nativeGrants, grantsDigest, grantTargets)
    if (!grantNative) return refuse('SURFACE_INPUT_INVALID', 'directory grants require exact native fragments bound to the same projection')

    const whole = new Map<string, Contribution[]>()
    const markdown = new Map<string, Contribution[]>()
    const openCodeLines: Contribution[] = []
    const native = new Map<string, NativeSurfaceFragment[]>()
    const browserMcp = new Map<string, Contribution>()
    const readonly = new Map<string, string>()
    const symlinks: SurfaceDesiredEntry[] = []
    const add = (map: Map<string, Contribution[]>, path: string, contribution: Contribution) => map.set(path, [...map.get(path) ?? [], contribution])
    if (browserRunner) add(whole, '.cockpit/browser/runner.sh', {
        harnesses: [...configuredSet], scope: 'always', capability: 'instructed', bytes: browserRunner.bytes as string,
    })
    for (const candidate of captured.generated.files) {
        if (!object(candidate) || !exact(candidate, ['target', 'path', 'bytes', 'sha256']) || typeof candidate.target !== 'string'
            || !configuredSet.has(candidate.target) || !validFileFields(candidate)) return refuse('SURFACE_INPUT_INVALID', 'generated surface output is malformed')
        const contribution = { harnesses: [candidate.target], scope: 'always' as const, capability: 'instructed' as const, bytes: stripDevelopmentMarkers(candidate.bytes as string) }
        add(MARKDOWN_PATHS.has(candidate.path as string) ? markdown : whole, candidate.path as string, contribution)
    }
    if (browser && Array.isArray(browser.files)) for (const candidate of browser.files) {
        if (!object(candidate) || !exact(candidate, ['target', 'path', 'bytes', 'sha256']) || typeof candidate.target !== 'string'
            || !BUILT_INS.has(candidate.target as SurfaceTarget) || !configuredSet.has(candidate.target) || !validFileFields(candidate)) {
            return refuse('SURFACE_INPUT_INVALID', 'browser surface output is malformed')
        }
        const path = candidate.path as string
        const contribution = { harnesses: [candidate.target as string], scope: 'always' as const,
            capability: 'instructed' as const, bytes: stripDevelopmentMarkers(candidate.bytes as string) }
        if (path.endsWith('/skills/browser/SKILL.md')) {
            add(whole, path, contribution)
            add(whole, `${path.slice(0, -'SKILL.md'.length)}references/browser.md`, { ...contribution, bytes: stripDevelopmentMarkers(captured.browserReference as string) })
        } else if (['.mcp.json', '.codex/config.toml', 'opencode.jsonc'].includes(path)) {
            if (browserMcp.has(path)) return refuse('SURFACE_PATH_CONFLICT', 'browser emitted duplicate native MCP output', path)
            browserMcp.set(path, contribution)
        } else return refuse('SURFACE_INPUT_INVALID', 'browser emitted an unsupported physical path', path)
    }
    const instructionPaths = [['claudecode', 'CLAUDE.md'], ['codexcli', 'AGENTS.md'], ['opencode', 'AGENTS.md']] as const
    if (typeof captured.instructions === 'string') for (const [target, path] of instructionPaths) {
        add(markdown, path, { harnesses: [target], scope: 'always', capability: 'instructed', bytes: captured.instructions })
    }
    if (testing && tierGuide && nativeHooks) {
        for (const [target, path] of instructionPaths) {
            add(markdown, path, { harnesses: [target], scope: 'always', capability: 'instructed', bytes: stripDevelopmentMarkers(tierGuide.bytes as string) })
        }
        const hooks = nativeHooks
        if (hooks.kind === 'complete') {
            if (!exact(hooks, ['kind', 'entries', 'cost', 'activation']) || !Array.isArray(hooks.entries) || hooks.entries.length !== 1) {
                return refuse('SURFACE_INPUT_INVALID', 'native hook projection is malformed')
            }
            if (!object(hooks.cost) || !exact(hooks.cost, ['kind', 'scope', 'executionSha256', 'limitMs', 'measuredMs'])
                || hooks.cost.kind !== 'within-budget' || hooks.cost.scope !== 'supplied-execution-environment'
                || typeof hooks.cost.executionSha256 !== 'string' || !SHA256.test(hooks.cost.executionSha256)
                || typeof hooks.cost.limitMs !== 'number' || !Number.isSafeInteger(hooks.cost.limitMs) || hooks.cost.limitMs < 1
                || typeof hooks.cost.measuredMs !== 'number' || !Number.isSafeInteger(hooks.cost.measuredMs) || hooks.cost.measuredMs < 0 || hooks.cost.measuredMs > hooks.cost.limitMs
                || !object(hooks.activation) || !exact(hooks.activation, ['kind', 'hooksPath', 'mode'])
                || hooks.activation.kind !== 'explicit-native-install' || hooks.activation.hooksPath !== '.githooks'
                || hooks.activation.mode !== 493) return refuse('SURFACE_INPUT_INVALID', 'native hook projection is malformed')
            const hook = hooks.entries[0]
            if (!object(hook) || !exact(hook, ['path', 'kind', 'ownership', 'harnesses', 'writer', 'schemaVersion', 'scope', 'capability', 'bytes', 'sha256'])
                || hook.path !== '.githooks/pre-push' || hook.kind !== 'file' || hook.ownership !== 'whole-file'
                || hook.writer !== 'cockpit' || hook.schemaVersion !== 1 || hook.scope !== 'scoped' || hook.capability !== 'instructed'
                || !Array.isArray(hook.harnesses) || hook.harnesses.length === 0 || hook.harnesses.some(value => typeof value !== 'string' || !configuredSet.has(value))
                || !validFileFields(hook)) return refuse('SURFACE_INPUT_INVALID', 'native hook projection is malformed')
            add(whole, hook.path, { harnesses: hook.harnesses as string[], scope: 'scoped', capability: 'instructed', bytes: hook.bytes as string })
        } else if ((hooks.kind !== 'not-installed' && hooks.kind !== 'ci-required' && hooks.kind !== 'refusal')
            || !exact(hooks, ['kind', 'reason']) || typeof hooks.reason !== 'string' || hooks.reason.length === 0
            || Buffer.byteLength(hooks.reason) > 4_096) return refuse('SURFACE_INPUT_INVALID', 'native hook projection is malformed')
        else if (hooks.kind !== 'not-installed') return refuse('SURFACE_INPUT_INVALID', hooks.reason, '.githooks/pre-push')
    }
    for (const fragment of [...mcpNative, ...grantNative]) native.set(fragment.path, [...native.get(fragment.path) ?? [], fragment])
    for (const wrapper of captured.mcp.result.wrappers) {
        if (!validFile(wrapper)) return refuse('SURFACE_INPUT_INVALID', 'MCP wrapper output is malformed')
        const server = captured.mcp.result.servers.find(row => object(row) && typeof row.name === 'string'
            && wrapper.path === `.cockpit/mcp/${digest(row.name)}.sh`)
        const harnesses = object(server) ? captured.mcp.result.harnesses.filter(row => object(row)
            && Array.isArray(row.servers) && row.servers.some(transport => object(transport) && transport.name === server.name))
            .map(row => (row as JsonSnapshotObject).target as string) : []
        if (harnesses.length === 0) return refuse('SURFACE_INPUT_INVALID', 'MCP wrapper has no matching native transport')
        add(whole, wrapper.path as string, { harnesses, scope: 'always', capability: 'instructed', bytes: wrapper.bytes as string })
    }
    for (const link of captured.projection.links) {
        if (!object(link) || typeof link.path !== 'string' || typeof link.target !== 'string' || typeof link.sourceContentPath !== 'string'
            || typeof link.sourceContentSha256 !== 'string' || typeof link.sourceContentIdentity !== 'string') return refuse('SURFACE_INPUT_INVALID', 'projection link is malformed')
        const owners = sorted(captured.projection.native.filter(row => object(row) && row.linkPath === link.path).map(row => (row as JsonSnapshotObject).target as string))
        if (!owners) return refuse('SURFACE_INPUT_INVALID', 'projection link has no configured native consumer', link.path)
        const guide = evidence.find(row => row.kind === 'guide' && row.path === link.sourceGuidePath
            && row.sha256 === link.sourceContentSha256 && row.identity === link.sourceContentIdentity)
        if (!guide || guide.kind !== 'guide') return refuse('SURFACE_INPUT_INVALID', 'projection link lost its guide evidence', link.path)
        symlinks.push({ kind: 'symlink', path: link.path, harnesses: owners, scope: 'scoped', capability: 'instructed', writer: 'cockpit', schemaVersion: 1,
            ownership: 'symlink', target: link.target, source: { root: guide.root, path: link.sourceGuidePath as string,
                sha256: link.sourceContentSha256, identity: link.sourceContentIdentity } })
    }
    for (const native of captured.projection.native) {
        if (!object(native) || typeof native.target !== 'string' || !configuredSet.has(native.target) || typeof native.path !== 'string'
            || typeof native.spelling !== 'string' || native.capability !== 'instructed') return refuse('SURFACE_INPUT_INVALID', 'native projection is malformed')
        const contribution = { harnesses: [native.target], scope: 'always' as const, capability: 'instructed' as const, bytes: native.spelling }
        if (native.path === 'opencode.jsonc') openCodeLines.push(contribution)
        else if (MARKDOWN_PATHS.has(native.path)) add(markdown, native.path, contribution)
        else return refuse('SURFACE_OWNERSHIP_INVALID', 'native projection names an unsupported shared path', native.path)
    }
    const restrictedHarnesses = captured.restrictions.targets.filter(row => object(row) && row.capability === 'instructed')
        .map(row => (row as JsonSnapshotObject).target as string)
    if (restrictedHarnesses.length > 0) add(whole, captured.restrictions.sharedGuard.path as string, {
        harnesses: restrictedHarnesses, scope: 'always', capability: 'instructed', bytes: captured.restrictions.sharedGuard.bytes as string,
    })
    for (const target of captured.restrictions.targets) {
        if (!object(target) || typeof target.target !== 'string' || !configuredSet.has(target.target) || !Array.isArray(target.files) || !object(target.readonly)) {
            return refuse('SURFACE_INPUT_INVALID', 'restriction output is malformed')
        }
        if (target.capability === 'unavailable') {
            if (target.files.length !== 0 || target.readonly.fragment !== null) return refuse('SURFACE_INPUT_INVALID', 'unavailable restriction target emitted output')
            continue
        }
        if (target.capability !== 'instructed') return refuse('SURFACE_INPUT_INVALID', 'restriction capability was promoted')
        for (const file of target.files) {
            if (!validFile(file)) return refuse('SURFACE_INPUT_INVALID', 'restriction file is malformed')
            add(whole, file.path as string, { harnesses: [target.target], scope: 'always', capability: 'instructed', bytes: file.bytes as string })
        }
        if (target.readonly.fragment !== null) {
            const fragment = target.readonly.fragment
            if (!validFile(fragment)) return refuse('SURFACE_INPUT_INVALID', 'readonly fragment is malformed')
            if (readonly.has(fragment.path as string)) return refuse('SURFACE_PATH_CONFLICT', 'readonly fragment conflicts', fragment.path as string)
            readonly.set(fragment.path as string, fragment.bytes as string)
        }
    }
    for (const { receipt, file } of custom.contributions) add(MARKDOWN_PATHS.has(file.path) ? markdown : whole, file.path, {
        harnesses: [receipt.harness], scope: file.scope, capability: receipt.state, bytes: file.bytes,
    })

    for (const [path, fragments] of native) {
        const finalBytes = new Set(fragments.map(fragment => fragment.bytes))
        if (finalBytes.size !== 1) return refuse('SURFACE_PATH_CONFLICT', 'native fragments for one physical path diverge', path)
        const contributions = whole.get(path) ?? []
        const replaced = new Set<string>()
        for (const fragment of fragments) {
            const baseRow = captured.generated.files.find(row => object(row) && row.target === fragment.target && row.path === path)
            if (baseRow === undefined) {
                if (fragment.baseSha256 !== digest('')) return refuse('SURFACE_INPUT_INVALID', 'native fragment is not bound to an absent base', path)
            } else if (!object(baseRow) || baseRow.sha256 !== fragment.baseSha256) {
                return refuse('SURFACE_INPUT_INVALID', 'native fragment base digest does not match generated output', path)
            } else replaced.add(`${fragment.target}\0${baseRow.bytes as string}`)
        }
        const retained = contributions.filter(row => !row.harnesses.some(harness => replaced.has(`${harness}\0${row.bytes}`)))
        whole.set(path, [...retained, { harnesses: fragments.map(fragment => fragment.target), scope: 'always', capability: 'instructed', bytes: fragments[0]!.bytes }])
    }
    for (const [path, contribution] of browserMcp) {
        const bases = whole.get(path)
        if (!bases || bases.length !== 1) return refuse('SURFACE_PATH_CONFLICT', 'browser MCP requires one existing native configuration', path)
        const bytes = mergeBrowserMcp(path, bases[0]!.bytes, contribution.bytes)
        if (!bytes) return refuse('SURFACE_PATH_CONFLICT', 'browser MCP conflicts with an existing server', path)
        whole.set(path, [{ harnesses: [...bases[0]!.harnesses, ...contribution.harnesses], scope: 'always',
            capability: weakest([bases[0]!.capability, contribution.capability]), bytes }])
    }

    for (const [path, fragment] of readonly) {
        const bases = whole.get(path)
        if (!bases || bases.length !== 1) return refuse('SURFACE_PATH_CONFLICT', 'readonly fragment requires one generated agent file', path)
        const combined = frontmatter(bases[0]!.bytes, fragment)
        if (combined === undefined) return refuse('SURFACE_PATH_CONFLICT', 'readonly frontmatter conflicts with the generated agent file', path)
        whole.set(path, [{ ...bases[0]!, bytes: combined }])
    }

    const entries: SurfaceDesiredEntry[] = [...symlinks]
    for (const [path, contributions] of whole) {
        if (path === 'opencode.jsonc') continue
        const distinct = [...new Set(contributions.map(row => row.bytes))]
        let bytes: string | undefined
        if (distinct.length === 1) bytes = distinct[0]
        else if (path === '.claude/settings.json' || path === '.codex/hooks.json') bytes = hookJson(contributions)
        if (bytes === undefined) return refuse('SURFACE_PATH_CONFLICT', 'producers emitted divergent bytes without a purpose-built composition rule', path)
        const harnesses = sorted(contributions.flatMap(row => row.harnesses))
        if (!harnesses) return refuse('SURFACE_INPUT_INVALID', 'physical output has no configured harness', path)
        const scope = sharedScope(contributions)
        if (!scope) return refuse('SURFACE_PATH_CONFLICT', 'producers emitted inconsistent scopes for one physical path', path)
        entries.push({ kind: 'file', path, harnesses, scope, capability: weakest(contributions.map(row => row.capability)), writer: 'cockpit', schemaVersion: 1,
            ownership: 'whole-file', bytes, sha256: digest(bytes) })
    }
    for (const [path, contributions] of markdown) {
        const generatorRows = captured.generated.files.filter(row => object(row) && row.path === path)
        if (generatorRows.length > 1 && new Set(generatorRows.map(row => object(row) ? row.bytes : undefined)).size !== 1) {
            return refuse('SURFACE_PATH_CONFLICT', 'shared generator instruction bases diverge', path)
        }
        const base = generatorRows.length > 0 && object(generatorRows[0]) ? stripDevelopmentMarkers(generatorRows[0].bytes as string) : ''
        const additions = contributions.filter(row => row.bytes !== base).map(row => row.bytes)
        const body = [base.replace(/\n+$/, ''), ...new Set(additions)].filter(Boolean).join('\n') + '\n'
        const harnesses = sorted(contributions.flatMap(row => row.harnesses))
        if (!harnesses) return refuse('SURFACE_INPUT_INVALID', 'shared Markdown output has no configured harness', path)
        const scope = sharedScope(contributions)
        if (!scope) return refuse('SURFACE_PATH_CONFLICT', 'producers emitted inconsistent scopes for one physical path', path)
        entries.push({ kind: 'shared-region', path, harnesses, scope, capability: weakest(contributions.map(row => row.capability)), writer: 'cockpit', schemaVersion: 1,
            ownership: 'shared-region', regionId: 'cockpit-instructions', region: { format: 'markdown-delimited',
                begin: '<!-- cockpit:instructions:start -->', end: '<!-- cockpit:instructions:end -->', bytes: body, sha256: digest(body) } })
    }

    const openCode = whole.get('opencode.jsonc') ?? []
    if (openCode.length > 0 || openCodeLines.length > 0) {
        const distinct = [...new Set(openCode.map(row => row.bytes))]
        if (distinct.length !== 1) return refuse('SURFACE_PATH_CONFLICT', 'OpenCode native producers emitted divergent base bytes', 'opencode.jsonc')
        const members = captureOpenCodeRootMembers(distinct[0]!)
        if (!members) return refuse('SURFACE_OWNERSHIP_INVALID', 'OpenCode base must be strict JSON containing only admitted native root keys', 'opencode.jsonc')
        const byKey = new Map(members.map(member => [member.key, member]))
        if (openCodeLines.length > 0) {
            const current = byKey.get('instructions')
            let instructions: unknown = []
            if (current) try { instructions = JSON.parse(current.valueBytes) } catch { return refuse('SURFACE_INPUT_INVALID', 'OpenCode instructions are malformed') }
            if (!Array.isArray(instructions) || instructions.some(value => typeof value !== 'string')) return refuse('SURFACE_PATH_CONFLICT', 'OpenCode instructions are not a string array')
            const values = [...new Set([...instructions, ...openCodeLines.map(row => row.bytes)])]
            byKey.set('instructions', { key: 'instructions', valueBytes: JSON.stringify(values) })
        }
        const grouped = [...byKey.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
        const contributions = [...openCode, ...openCodeLines]
        const harnesses = sorted(contributions.flatMap(row => row.harnesses))
        if (!harnesses) return refuse('SURFACE_INPUT_INVALID', 'OpenCode output has no configured harness')
        const scope = sharedScope(contributions)
        if (!scope) return refuse('SURFACE_PATH_CONFLICT', 'producers emitted inconsistent scopes for one physical path', 'opencode.jsonc')
        entries.push({ kind: 'shared-region', path: 'opencode.jsonc', harnesses, scope, capability: weakest(contributions.map(row => row.capability)), writer: 'cockpit', schemaVersion: 1,
            ownership: 'shared-region', regionId: 'cockpit-opencode-root-properties',
            region: { format: 'opencode-json-root-properties', members: grouped, sha256: digest(JSON.stringify(grouped)) } })
    }
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const ownership = classifySurfaceOwnership({ configuredHarnesses: configured, entries })
    if (ownership.kind === 'refusal') return ownership
    const result = snapshotGeneratedJson({ kind: 'complete', entries: ownership.entries, warnings,
        inputs: [...evidence, ...custom.evidence].sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0) })
    return result ? result as unknown as SurfaceRenderResult : refuse('SURFACE_BOUNDS', 'surface render result exceeds the captured bounds')
}
