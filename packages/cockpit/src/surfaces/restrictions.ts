import { createHash } from 'node:crypto'
import { isAbsolute, posix } from 'node:path'

import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import { GUARD_SURFACE_TARGETS, type GuardSurfaceTarget } from './harness-registry.js'
import { GUARD_HANDLER_ARGV } from '../guards/harness-adapter.js'
import { GUARD_HOST_LIMITS, isGuardHost, normalizeGuardHost } from '../guards/host.js'

export const mechanism = {
    id: 'surface-restrictions',
    module: 'packages/cockpit/src/surfaces/restrictions.ts',
    exports: ['expandRestrictions', 'inspectShippedRestrictionCapabilities', 'compareRestrictionOutputs', 'RESTRICTION_OUTPUT_LIMITS', 'validateGuardRegistration'],
} as const

export const RESTRICTION_OUTPUT_LIMITS = Object.freeze({
    scalarBytes: 65_536,
    aggregateBytes: 102_400,
    fileCount: 8,
} as const)

export interface InstancePathTarget {
    readonly kind: 'instance'
    readonly name: string
    readonly root?: string
    readonly path: string
}

export interface RestrictionPolicy {
    readonly hosted_db_hosts: readonly string[]
    readonly protected_branches: readonly string[]
    readonly readonly: { readonly kind: 'agent'; readonly name: string }
}

interface NativeRestrictionAdapter {
    readonly format: 'cockpit-restriction-adapter/v1'
    readonly target: GuardSurfaceTarget
    readonly mechanism: 'native'
    readonly promptTier: boolean
    readonly measuredOn: string
    readonly measuredVersion: string
    readonly provenance: string
    readonly registration: {
        readonly kind: 'hooks-json' | 'opencode-plugin'
        readonly path: string
        readonly event: 'PreToolUse' | 'tool.execute.before'
        readonly matcher: string
    }
    readonly payload: {
        readonly kind: 'pre-tool-use' | 'opencode-before'
        readonly bashTool: 'Bash' | 'bash'
        readonly editTools: readonly string[]
    }
    readonly readonly: {
        readonly kind: 'agent-frontmatter' | 'instruction-only'
        readonly pathPattern?: string
        readonly bytes?: string
        readonly reason?: string
    }
}

interface UnavailableRestrictionAdapter {
    readonly format: 'cockpit-restriction-adapter/v1'
    readonly target: GuardSurfaceTarget
    readonly mechanism: 'unavailable'
    readonly measuredOn: string
    readonly measuredVersion: null
    readonly provenance: string
    readonly reason: string
}

export type RestrictionAdapter = NativeRestrictionAdapter | UnavailableRestrictionAdapter

export interface RestrictionExpansionInput {
    readonly canonicalProjectRoot: string
    readonly allowedProjectRoots?: readonly string[]
    readonly guardTemplate: string
    readonly guardPath: string
    readonly instances: readonly InstancePathTarget[]
    readonly policy: RestrictionPolicy
    readonly adapters: readonly unknown[]
    /** The configuration's path relative to the project root; the guard names it in its fix command. */
    readonly configFile: string
}

interface CapturedRestrictionExpansionInput extends Omit<RestrictionExpansionInput, 'allowedProjectRoots' | 'instances'> {
    readonly allowedProjectRoots: readonly string[]
    readonly instances: readonly (InstancePathTarget & { readonly root: string })[]
}

export interface RestrictionFile {
    readonly path: string
    readonly bytes: string
    readonly sha256: string
}

export interface RestrictionReadonlyOutput {
    readonly agent: string
    readonly capability: 'instructed' | 'unavailable'
    readonly evidenceStatus: 'pending_evidence' | 'not_applicable'
    readonly reason: string
    readonly fragment: RestrictionFile | null
}

export interface RestrictionTargetOutput {
    readonly target: GuardSurfaceTarget
    readonly capability: 'instructed' | 'unavailable'
    readonly evidenceStatus: 'pending_evidence' | 'not_applicable'
    readonly measuredOn: string
    readonly measuredVersion: string | null
    readonly provenance: string
    readonly files: readonly RestrictionFile[]
    readonly readonly: RestrictionReadonlyOutput
}

export interface ShippedRestrictionCapability {
    readonly target: GuardSurfaceTarget
    readonly capability: 'instructed' | 'unavailable'
    readonly evidenceStatus: 'pending_evidence' | 'not_applicable'
    readonly measuredOn: string
    readonly measuredVersion: string | null
    readonly provenance: string
}

export type ShippedRestrictionCapabilities = Readonly<{
    readonly kind: 'complete'
    readonly targets: readonly ShippedRestrictionCapability[]
}> | RestrictionExpansionRefusal

export interface RestrictionExpansionComplete {
    readonly kind: 'complete'
    readonly sharedGuard: RestrictionFile
    readonly targets: readonly RestrictionTargetOutput[]
}

export interface RestrictionExpansionRefusal {
    readonly kind: 'refusal'
    readonly code: 'RESTRICTION_INPUT_INVALID'
        | 'RESTRICTION_ADAPTER_INVALID' | 'RESTRICTION_EVENT_UNADAPTED'
        | 'RESTRICTION_TEMPLATE_INVALID' | 'RESTRICTION_OUTPUT_LIMIT'
    readonly message: string
}

export type RestrictionExpansionResult = RestrictionExpansionComplete | RestrictionExpansionRefusal

const FORMAT = 'cockpit-restriction-adapter/v1'
// Generated bytes are committed, so the only value rendered into the guard is root-relative; the
// handler identity that names this machine is written to the ignored local file instead.
const MARKERS = Object.freeze({
    config: '__COCKPIT_GUARD_CONFIG__',
})
const DATE = /^\d{4}-\d{2}-\d{2}$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/
const GUARD_PATH = '.cockpit/guards/bash-guard.sh'
const MAX_INSTANCES = 256
const MAX_POLICY_ROWS = 128
const NATIVE_PROVENANCE = Object.freeze({
    claudecode: 'paired native PreToolUse payload and decision probe',
    codexcli: 'paired native PreToolUse payload, apply_patch and ask-decision probe',
    opencode: 'paired native tool.execute.before payload, apply_patch and thrown-refusal probe',
} satisfies Record<GuardSurfaceTarget, string>)
const MEASURED = Object.freeze({
    claudecode: { date: '2026-08-25', version: '2.1.220' },
    codexcli: { date: '2026-08-24', version: '0.149.0' },
    opencode: { date: '2026-08-24', version: '1.18.15' },
} satisfies Record<GuardSurfaceTarget, { readonly date: string; readonly version: string }>)

function object(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: JsonSnapshotObject, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const wanted = [...expected].sort()
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function frozen<T>(value: T): T | undefined {
    const captured = snapshotJson(value)
    return captured === undefined ? undefined : captured as T
}

function refusal(code: RestrictionExpansionRefusal['code'], message: string): RestrictionExpansionRefusal {
    return frozen({ kind: 'refusal', code, message }) ?? Object.freeze({ kind: 'refusal', code, message })
}

function safeScalar(value: string, max = 4_096): boolean {
    return value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value)
}

function canonicalRoot(value: string): boolean {
    return safeScalar(value) && isAbsolute(value) && value !== '/' && !value.endsWith('/')
        && posix.normalize(value) === value && !value.includes('\\')
}

function confinedRelativePath(value: string): boolean {
    return safeScalar(value) && !isAbsolute(value) && !value.includes('\\') && posix.normalize(value) === value
        && value !== '.' && !value.split('/').some((part) => part === '..' || part.length === 0)
}

function boundedUniqueStrings(value: JsonSnapshot | undefined, pattern: RegExp, max: number): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length > max || !value.every((item) => typeof item === 'string' && pattern.test(item))) return undefined
    const strings = value as readonly string[]
    return new Set(strings).size === strings.length ? strings : undefined
}

function capturePolicy(value: JsonSnapshot | undefined): RestrictionPolicy | undefined {
    if (!object(value) || !exactKeys(value, ['hosted_db_hosts', 'protected_branches', 'readonly'])) return undefined
    const hosted = value.hosted_db_hosts
    if (!Array.isArray(hosted) || hosted.length > GUARD_HOST_LIMITS.rows || !hosted.every(isGuardHost)
        || new Set(hosted.map(normalizeGuardHost)).size !== hosted.length) return undefined
    const branches = boundedUniqueStrings(value.protected_branches, BRANCH, MAX_POLICY_ROWS)
    if (!hosted || !branches
        || !object(value.readonly) || !exactKeys(value.readonly, ['kind', 'name']) || value.readonly.kind !== 'agent'
        || typeof value.readonly.name !== 'string' || !NAME.test(value.readonly.name)) return undefined
    return value as unknown as RestrictionPolicy
}

function capturedInput(input: unknown): CapturedRestrictionExpansionInput | undefined {
    const value = snapshotJson(input)
    if (!object(value)) return undefined
    const inputKeys = ['canonicalProjectRoot', 'guardTemplate', 'guardPath', 'instances', 'policy', 'adapters', 'configFile']
    const hasAllowedRoots = Object.hasOwn(value, 'allowedProjectRoots')
    if (!exactKeys(value, hasAllowedRoots ? [...inputKeys, 'allowedProjectRoots'] : inputKeys)
        || typeof value.canonicalProjectRoot !== 'string' || !canonicalRoot(value.canonicalProjectRoot)
        || typeof value.guardTemplate !== 'string' || value.guardPath !== GUARD_PATH
        || !Array.isArray(value.instances) || value.instances.length > MAX_INSTANCES || !Array.isArray(value.adapters)
        || typeof value.configFile !== 'string' || !confinedRelativePath(value.configFile)) return undefined
    const allowedProjectRoots = hasAllowedRoots ? value.allowedProjectRoots : [value.canonicalProjectRoot]
    if (!Array.isArray(allowedProjectRoots) || allowedProjectRoots.length === 0 || allowedProjectRoots.length > MAX_INSTANCES
        || !allowedProjectRoots.every((root) => typeof root === 'string' && canonicalRoot(root))
        || new Set(allowedProjectRoots).size !== allowedProjectRoots.length
        || !allowedProjectRoots.includes(value.canonicalProjectRoot)) return undefined
    const names = new Set<string>()
    const paths = new Set<string>()
    const instances: Array<InstancePathTarget & { readonly root: string }> = []
    for (const target of value.instances) {
        if (!object(target)) return undefined
        const hasRoot = Object.hasOwn(target, 'root')
        if (!exactKeys(target, hasRoot ? ['kind', 'name', 'root', 'path'] : ['kind', 'name', 'path']) || target.kind !== 'instance'
            || typeof target.name !== 'string' || !NAME.test(target.name) || names.has(target.name)
            || typeof target.path !== 'string' || !confinedRelativePath(target.path)) return undefined
        const root = hasRoot ? target.root : value.canonicalProjectRoot
        if (typeof root !== 'string' || !allowedProjectRoots.includes(root)) return undefined
        const path = posix.join(root, target.path)
        if (paths.has(path)) return undefined
        names.add(target.name)
        paths.add(path)
        instances.push({ kind: 'instance', name: target.name, root, path: target.path })
    }
    const policy = capturePolicy(value.policy)
    return policy ? {
        ...value as unknown as RestrictionExpansionInput,
        allowedProjectRoots: allowedProjectRoots as readonly string[],
        instances,
    } : undefined
}

function stringArray(value: JsonSnapshot | undefined): readonly string[] | undefined {
    return Array.isArray(value) && value.length > 0 && value.length <= 8
        && value.every((item) => typeof item === 'string') ? value as readonly string[] : undefined
}

function measuredFields(value: JsonSnapshotObject): boolean {
    return typeof value.measuredOn === 'string' && DATE.test(value.measuredOn)
        && typeof value.measuredVersion === 'string' && VERSION.test(value.measuredVersion)
        && typeof value.provenance === 'string' && safeScalar(value.provenance, 200)
        && !/credential|secret|token|password|private[ _-]?key/i.test(value.provenance)
}

function unavailableAdapter(value: JsonSnapshotObject): UnavailableRestrictionAdapter | undefined {
    if (!exactKeys(value, ['format', 'target', 'mechanism', 'measuredOn', 'measuredVersion', 'provenance', 'reason'])
        || value.format !== FORMAT || value.mechanism !== 'unavailable' || value.measuredVersion !== null
        || typeof value.target !== 'string' || !GUARD_SURFACE_TARGETS.includes(value.target as GuardSurfaceTarget)
        || typeof value.measuredOn !== 'string' || !DATE.test(value.measuredOn)
        || typeof value.provenance !== 'string' || !safeScalar(value.provenance, 200)
        || /credential|secret|token|password|private[ _-]?key/i.test(value.provenance)
        || typeof value.reason !== 'string' || !safeScalar(value.reason, 300)) return undefined
    return value as unknown as UnavailableRestrictionAdapter
}

function nativeShapeMatches(adapter: NativeRestrictionAdapter): boolean {
    if (adapter.target === 'claudecode') return adapter.promptTier
        && adapter.registration.kind === 'hooks-json' && adapter.registration.path === '.claude/settings.json'
        && adapter.registration.event === 'PreToolUse' && adapter.registration.matcher === 'Bash|Edit|Write|NotebookEdit'
        && adapter.payload.kind === 'pre-tool-use' && adapter.payload.bashTool === 'Bash'
        && JSON.stringify(adapter.payload.editTools) === JSON.stringify(['Edit', 'Write', 'NotebookEdit'])
        && adapter.readonly.kind === 'agent-frontmatter' && adapter.readonly.pathPattern === '.claude/agents/{agent}.md'
        && adapter.readonly.bytes === 'disallowedTools: Edit, Write, NotebookEdit\n'
    if (adapter.target === 'codexcli') return !adapter.promptTier
        && adapter.registration.kind === 'hooks-json' && adapter.registration.path === '.codex/hooks.json'
        && adapter.registration.event === 'PreToolUse' && adapter.registration.matcher === 'Bash|Edit|Write|apply_patch'
        && adapter.payload.kind === 'pre-tool-use' && adapter.payload.bashTool === 'Bash'
        && JSON.stringify(adapter.payload.editTools) === JSON.stringify(['Edit', 'Write', 'apply_patch'])
        && adapter.readonly.kind === 'instruction-only' && adapter.readonly.reason === 'agent role edit restrictions were measured inert'
    return !adapter.promptTier && adapter.registration.kind === 'opencode-plugin'
        && adapter.registration.path === '.opencode/plugin/cockpit-guards.js'
        && adapter.registration.event === 'tool.execute.before' && adapter.registration.matcher === 'bash|edit|write|apply_patch'
        && adapter.payload.kind === 'opencode-before' && adapter.payload.bashTool === 'bash'
        && JSON.stringify(adapter.payload.editTools) === JSON.stringify(['edit', 'write', 'apply_patch'])
        && adapter.readonly.kind === 'agent-frontmatter' && adapter.readonly.pathPattern === '.opencode/agents/{agent}.md'
        && adapter.readonly.bytes === 'permission:\n  edit: deny\n'
}

function nativeAdapter(value: JsonSnapshotObject): NativeRestrictionAdapter | undefined {
    if (!exactKeys(value, ['format', 'target', 'mechanism', 'promptTier', 'measuredOn', 'measuredVersion', 'provenance', 'registration', 'payload', 'readonly'])
        || value.format !== FORMAT || value.mechanism !== 'native' || typeof value.promptTier !== 'boolean'
        || typeof value.target !== 'string' || !GUARD_SURFACE_TARGETS.includes(value.target as GuardSurfaceTarget) || !measuredFields(value)
        || !object(value.registration) || !exactKeys(value.registration, ['kind', 'path', 'event', 'matcher'])
        || typeof value.registration.kind !== 'string' || typeof value.registration.path !== 'string'
        || typeof value.registration.event !== 'string' || typeof value.registration.matcher !== 'string'
        || !object(value.payload) || !exactKeys(value.payload, ['kind', 'bashTool', 'editTools'])
        || typeof value.payload.kind !== 'string' || typeof value.payload.bashTool !== 'string' || !stringArray(value.payload.editTools)
        || !object(value.readonly)) return undefined
    const readonlyKeys = value.readonly.kind === 'agent-frontmatter' ? ['kind', 'pathPattern', 'bytes'] : ['kind', 'reason']
    if (!exactKeys(value.readonly, readonlyKeys)) return undefined
    const adapter = value as unknown as NativeRestrictionAdapter
    const measurement = MEASURED[adapter.target]
    return nativeShapeMatches(adapter) && adapter.measuredOn === measurement.date
        && adapter.measuredVersion === measurement.version && adapter.provenance === NATIVE_PROVENANCE[adapter.target]
        ? adapter : undefined
}

function captureAdapter(input: unknown): RestrictionAdapter | undefined {
    const value = snapshotJson(input)
    if (!object(value)) return undefined
    return value.mechanism === 'unavailable' ? unavailableAdapter(value) : nativeAdapter(value)
}

const issuedShippedRestrictionCapabilities = new WeakSet<object>()
const shippedRestrictionBindings = new WeakMap<object, Readonly<{
    adapters: ReadonlyMap<GuardSurfaceTarget, RestrictionAdapter>
}>>()

function validGuardTemplate(value: string): boolean {
    return Buffer.byteLength(value) <= RESTRICTION_OUTPUT_LIMITS.scalarBytes
        && !/[\uD800-\uDFFF]/u.test(value)
        && Object.values(MARKERS).every(marker => value.split(marker).length === 2)
}

export function inspectShippedRestrictionCapabilities(input: unknown): ShippedRestrictionCapabilities {
    const value = snapshotJson(input)
    if (!object(value) || !exactKeys(value, ['guardTemplate', 'adapters'])
        || typeof value.guardTemplate !== 'string' || !Array.isArray(value.adapters)) {
        return refusal('RESTRICTION_INPUT_INVALID', 'shipped restriction inspection requires bounded guard template and adapter bytes')
    }
    if (!validGuardTemplate(value.guardTemplate)) {
        return refusal('RESTRICTION_TEMPLATE_INVALID', 'guard template must contain every transport identity marker exactly once')
    }
    const adapters = new Map<GuardSurfaceTarget, RestrictionAdapter>()
    for (const candidate of value.adapters) {
        const adapter = captureAdapter(candidate)
        if (!adapter || adapters.has(adapter.target)) {
            return refusal('RESTRICTION_ADAPTER_INVALID', 'restriction adapters must use one closed measured transport shape per target')
        }
        adapters.set(adapter.target, adapter)
    }
    const missing = GUARD_SURFACE_TARGETS.find(target => !adapters.has(target))
    if (missing) return refusal('RESTRICTION_EVENT_UNADAPTED', `restriction event has no adapter for ${missing}`)

    const targets = GUARD_SURFACE_TARGETS.map((target): ShippedRestrictionCapability => {
        const adapter = adapters.get(target)!
        const row = Object.freeze({
            target,
            capability: adapter.mechanism === 'unavailable' ? 'unavailable' as const : 'instructed' as const,
            evidenceStatus: adapter.mechanism === 'unavailable' ? 'not_applicable' as const : 'pending_evidence' as const,
            measuredOn: adapter.measuredOn,
            measuredVersion: adapter.measuredVersion,
            provenance: adapter.provenance,
        })
        issuedShippedRestrictionCapabilities.add(row)
        return row
    })
    const result = Object.freeze({ kind: 'complete' as const, targets: Object.freeze(targets) })
    issuedShippedRestrictionCapabilities.add(result)
    shippedRestrictionBindings.set(result, Object.freeze({ adapters }))
    return result
}

function digest(bytes: string): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function file(path: string, bytes: string): RestrictionFile {
    return { path, bytes, sha256: digest(bytes) }
}

function shellLiteral(value: string): string {
    return value.replaceAll("'", "'\\''")
}

// Registrations are committed, so each finds the cockpit checkout at run time through the
// mechanism its harness documents: Claude Code exports the project directory to hooks, and Codex runs
// hooks in the session working directory. The Git root can be above a cockpit rooted in a subdirectory.
const HOOK_ROOT = Object.freeze({
    claudecode: { expression: '${CLAUDE_PROJECT_DIR:-}', source: 'CLAUDE_PROJECT_DIR' },
    codexcli: { expression: '$(pwd -P 2>/dev/null)', source: 'the canonical Codex session directory' },
} as const)

function hooksBytes(target: keyof typeof HOOK_ROOT, matcher: string, guardPath: string, askIsDeny: boolean, configFile: string): string {
    const root = HOOK_ROOT[target]
    // Both hook runners block only on exit 2; any other failure (a handler that cannot load, a killed
    // process, a missing shell) would let the tool call run, so it is folded into a blocking exit.
    const guard = `R="${root.expression}"; H="$R/${guardPath}"; test -n "$R" && test -f "$H" && test -r "$H" || { printf 'cockpit restriction guard missing: %s (the hook finds the cockpit checkout through ${root.source}), so every tool call is held. Fix: start the agent from the cockpit checkout; if the file is gone, run git restore ${guardPath} there (it is committed), or have a human run npx --no cockpit sync --config <your cockpit.toml> in a terminal.\\n' "$H" >&2; exit 2; }; ${askIsDeny ? 'COCKPIT_ASK_IS_DENY=1 ' : ''}/bin/bash "$H" --harness ${target}; s=$?; case $s in 0|2) exit $s;; esac; printf 'cockpit guard failed (exit %s)\\n' "$s" >&2; exit 2`
    // Claude Code 2.1.317 and Codex 0.166.0 (a trusted hook) each ran a SessionStart command and put its
    // stdout in the agent's context, measured 2026-11-03 beside a misspelled event that never ran. A
    // drift report there tells the agent what to re-sync before it works; the hook never blocks.
    const sessionStart = `R="${root.expression}"; test -n "$R" && test -x "$R/node_modules/.bin/cockpit" || exit 0; cd "$R" && ./node_modules/.bin/cockpit check --config ${shellLiteral(configFile)} 2>&1 | tail -n 40; exit 0`
    const hooks = { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: guard }] }], SessionStart: [{ hooks: [{ type: 'command', command: sessionStart }] }] }
    const value = target === 'codexcli' ? { description: 'Generated authenticated restriction transport and session-start drift check.', hooks } : { hooks }
    return `${JSON.stringify(value, null, 2)}\n`
}

function opencodeBytes(guardPath: string, configFile: string): string {
    // The plugin is committed, so it locates the guard from its own published location.
    const guard = `fileURLToPath(new URL(${JSON.stringify(`../../${guardPath}`)}, import.meta.url))`
    // OpenCode's native read, grep and glob tools never reach a shell, and OpenCode 1.19.4 returned a
    // secrets file through read while the plugin mapped only shell, edit and patch tools (2026-11-01).
    // The guard parses shell, edit and patch payloads only, so each native read is restated as the
    // shell command that reads at least the same paths: `cat` for read, a recursive `grep` for grep
    // (OpenCode searches hidden files too) and `ls` for glob, which reports names only.
    const readTools = `  if (tool === "Read") return typeof args.filePath === "string" ? shell(\`cat -- \${quote(args.filePath)}\`) : null\n  if (tool === "Grep" || tool === "Glob") {\n    if (typeof args.pattern !== "string" || args.path !== undefined && typeof args.path !== "string") return null\n    const path = quote(args.path ?? ".")\n    return shell(tool === "Grep" ? \`grep -r -e \${quote(args.pattern)} -- \${path}\` : \`ls -- \${path}\`)\n  }\n`
    return `import { spawnSync } from "node:child_process"\nimport { fileURLToPath } from "node:url"\n\nconst tools = { bash: "Bash", edit: "Edit", write: "Write", apply_patch: "apply_patch", read: "Read", grep: "Grep", glob: "Glob" }\n\nconst quote = (value) => \`'\${value.replaceAll("'", "'\\\\''")}'\`\nconst shell = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } })\n\nfunction payload(tool, args) {\n  if (tool === "Bash") return typeof args.command === "string" ? shell(args.command) : null\n  if (tool === "apply_patch") return typeof args.patchText === "string" ? { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: args.patchText } } : null\n${readTools}  const file_path = args.filePath ?? args.path ?? args.file\n  if (typeof file_path !== "string") return null\n  // The guard checks an edit of the configuration against its pinned policy tables, so that file's new text is sent.\n  const text = file_path.split("/").pop() !== ${JSON.stringify(configFile.split('/').pop())} ? {}\n    : tool === "Edit" ? { old_string: args.oldString, new_string: args.newString, replace_all: args.replaceAll === true } : { content: args.content }\n  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path, ...text } }\n}\n\nexport const CockpitRestrictions = async () => ({\n  "tool.execute.before": async (input, output) => {\n    const tool = tools[String(input?.tool ?? "").toLowerCase()]\n    if (!tool) return\n    const normalized = payload(tool, output?.args ?? {})\n    if (!normalized) throw new Error("cockpit restriction guard: malformed applicable payload")\n    const result = spawnSync("/bin/bash", [${guard}, "--harness", "opencode"], {\n      input: JSON.stringify(normalized), encoding: "utf8",\n      env: { ...process.env, COCKPIT_ASK_IS_DENY: "1" },\n    })\n    if (result.error) throw new Error(\`cockpit restriction guard failed: \${result.error.message}\`)\n    // A restated read names the command the guard judged, so the agent can narrow its path.\n    const checked = tool === "Read" || tool === "Grep" || tool === "Glob" ? \` (OpenCode \${tool.toLowerCase()} is checked as: \${normalized.tool_input.command})\` : ""\n    if (result.status !== 0) throw new Error((result.stderr.trim() || "cockpit restriction guard refused without a reason") + checked)\n    let decision\n    try { decision = JSON.parse(result.stdout || "{}")?.hookSpecificOutput }\n    catch { throw new Error("cockpit restriction guard returned malformed output") }\n    if (decision?.permissionDecision === "deny" || decision?.permissionDecision === "ask") {\n      throw new Error(\`cockpit restriction guard: \${decision.permissionDecisionReason}\${checked}\`)\n    }\n  },\n})\n`
}

function registration(adapter: NativeRestrictionAdapter, input: RestrictionExpansionInput): RestrictionFile {
    // The measured shapes pair OpenCode with its plugin and the other targets with hooks.json.
    // Codex and OpenCode have no ask tier, so a prompt they cannot show refuses instead of proceeding;
    // Claude Code shows the prompt.
    const bytes = adapter.target === 'opencode'
        ? opencodeBytes(input.guardPath, input.configFile)
        : hooksBytes(adapter.target, adapter.registration.matcher, input.guardPath, adapter.target === 'codexcli', input.configFile)
    return file(adapter.registration.path, bytes)
}

function readonlyOutput(adapter: RestrictionAdapter, agent: string): RestrictionReadonlyOutput {
    if (adapter.mechanism === 'unavailable') return {
        agent, capability: 'unavailable', evidenceStatus: 'not_applicable', reason: adapter.reason, fragment: null,
    }
    if (adapter.readonly.kind === 'instruction-only') return {
        agent, capability: 'instructed', evidenceStatus: 'pending_evidence', reason: adapter.readonly.reason!, fragment: null,
    }
    const path = adapter.readonly.pathPattern!.replace('{agent}', agent)
    return {
        agent, capability: 'instructed', evidenceStatus: 'pending_evidence',
        reason: 'native spelling generated; operator proof remains pending', fragment: file(path, adapter.readonly.bytes!),
    }
}

function renderGuard(input: CapturedRestrictionExpansionInput): string | undefined {
    if (!validGuardTemplate(input.guardTemplate)) return undefined
    let rendered = input.guardTemplate
    const replacements: Readonly<Record<string, string>> = {
        [MARKERS.config]: input.configFile,
    }
    for (const [marker, value] of Object.entries(replacements)) {
        if (rendered.split(marker).length !== 2) return undefined
        rendered = rendered.replace(marker, () => shellLiteral(value))
    }
    return rendered
}

function outputWithinLimits(value: RestrictionExpansionComplete): boolean {
    let files = 1
    const visit = (candidate: unknown): boolean => {
        if (typeof candidate === 'string') return Buffer.byteLength(candidate) <= RESTRICTION_OUTPUT_LIMITS.scalarBytes
        if (candidate === null || typeof candidate !== 'object') return true
        if (Array.isArray(candidate)) return candidate.every(visit)
        return Object.values(candidate).every(visit)
    }
    for (const row of value.targets) {
        files += row.files.length + (row.readonly.fragment === null ? 0 : 1)
    }
    return files <= RESTRICTION_OUTPUT_LIMITS.fileCount && visit(value)
        && Buffer.byteLength(JSON.stringify(value)) <= RESTRICTION_OUTPUT_LIMITS.aggregateBytes
}

export function expandRestrictions(input: unknown): RestrictionExpansionResult {
    const captured = capturedInput(input)
    if (!captured) return refusal('RESTRICTION_INPUT_INVALID', 'restriction input must be bounded own data with confined instance paths and an authenticated root')
    const capabilities = inspectShippedRestrictionCapabilities({
        guardTemplate: captured.guardTemplate,
        adapters: captured.adapters,
    })
    if (capabilities.kind === 'refusal') return capabilities
    const binding = issuedShippedRestrictionCapabilities.has(capabilities)
        && capabilities.targets.every(row => issuedShippedRestrictionCapabilities.has(row))
        ? shippedRestrictionBindings.get(capabilities) : undefined
    if (!binding) return refusal('RESTRICTION_ADAPTER_INVALID', 'restriction capabilities were not issued by the shipped restriction owner')
    const guardBytes = renderGuard(captured)
    if (guardBytes === undefined) {
        return refusal('RESTRICTION_TEMPLATE_INVALID', 'guard template must contain every transport identity marker exactly once')
    }

    const targets = GUARD_SURFACE_TARGETS.map((target): RestrictionTargetOutput => {
        const adapter = binding.adapters.get(target)!
        const capability = capabilities.targets.find(row => row.target === target)!
        if (adapter.mechanism === 'unavailable') return {
            ...capability, files: [],
            readonly: readonlyOutput(adapter, captured.policy.readonly.name),
        }
        return {
            ...capability,
            files: [registration(adapter, captured)], readonly: readonlyOutput(adapter, captured.policy.readonly.name),
        }
    })
    const result: RestrictionExpansionComplete = {
        kind: 'complete', sharedGuard: file(captured.guardPath, guardBytes), targets,
    }
    if (!outputWithinLimits(result)) {
        return refusal('RESTRICTION_OUTPUT_LIMIT', 'rendered restriction output exceeds scalar, aggregate, or file-count limits')
    }
    return frozen(result) ?? refusal('RESTRICTION_OUTPUT_LIMIT', 'rendered restriction output cannot be captured within bounded JSON limits')
}

function validFile(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return object(value) && exactKeys(value, ['path', 'bytes', 'sha256'])
        && typeof value.path === 'string' && safeScalar(value.path) && typeof value.bytes === 'string'
        && Buffer.byteLength(value.bytes) <= RESTRICTION_OUTPUT_LIMITS.scalarBytes
        && typeof value.sha256 === 'string' && value.sha256 === digest(value.bytes)
}

/** Capture the future registration without changing the operative installed guard. */
export function validateGuardRegistration(input: unknown) {
    const value = snapshotJson(input)
    if (!object(value) || !exactKeys(value, ['target', 'handler', 'cwd', 'argv', 'registration'])
        || typeof value.target !== 'string' || !GUARD_SURFACE_TARGETS.includes(value.target as GuardSurfaceTarget)
        || typeof value.handler !== 'string' || !canonicalRoot(value.handler)
        || typeof value.cwd !== 'string' || !canonicalRoot(value.cwd)
        || !Array.isArray(value.argv) || JSON.stringify(value.argv) !== JSON.stringify([...GUARD_HANDLER_ARGV, '--harness', value.target])
        || !object(value.registration) || !exactKeys(value.registration, ['path', 'bytes'])
        || typeof value.registration.path !== 'string' || !confinedRelativePath(value.registration.path)
        || typeof value.registration.bytes !== 'string' || !value.registration.bytes
        || Buffer.byteLength(value.registration.bytes) > RESTRICTION_OUTPUT_LIMITS.scalarBytes
        || /[\uD800-\uDFFF]/u.test(value.registration.bytes)) {
        return refusal('RESTRICTION_ADAPTER_INVALID', 'staged registration requires exact handler argv and bounded confined output bytes')
    }
    const paths = { claudecode: '.claude/settings.json', codexcli: '.codex/hooks.json', opencode: '.opencode/plugin/cockpit-guards.js' }
    if (value.registration.path !== paths[value.target as GuardSurfaceTarget]) {
        return refusal('RESTRICTION_ADAPTER_INVALID', 'staged registration path does not match its harness')
    }
    return frozen({ kind: 'complete' as const, target: value.target, handler: value.handler, cwd: value.cwd, argv: value.argv,
        registration: file(value.registration.path, value.registration.bytes) })
        ?? refusal('RESTRICTION_OUTPUT_LIMIT', 'staged registration cannot be captured within output limits')
}

function validReadonly(value: JsonSnapshot | undefined): boolean {
    return object(value) && exactKeys(value, ['agent', 'capability', 'evidenceStatus', 'reason', 'fragment'])
        && typeof value.agent === 'string' && NAME.test(value.agent) && typeof value.reason === 'string'
        && (value.fragment === null || validFile(value.fragment))
        && (value.capability === 'unavailable' && value.evidenceStatus === 'not_applicable' && value.fragment === null
            || value.capability === 'instructed' && value.evidenceStatus === 'pending_evidence')
}

function validExpansion(value: unknown): RestrictionExpansionComplete | undefined {
    const captured = snapshotJson(value)
    if (!object(captured) || !exactKeys(captured, ['kind', 'sharedGuard', 'targets']) || captured.kind !== 'complete'
        || !validFile(captured.sharedGuard) || !Array.isArray(captured.targets) || captured.targets.length !== GUARD_SURFACE_TARGETS.length) return undefined
    const seen = new Set<GuardSurfaceTarget>()
    for (const row of captured.targets) {
        if (!object(row) || !exactKeys(row, ['target', 'capability', 'evidenceStatus', 'measuredOn', 'measuredVersion', 'provenance', 'files', 'readonly'])
            || typeof row.target !== 'string' || !GUARD_SURFACE_TARGETS.includes(row.target as GuardSurfaceTarget) || seen.has(row.target as GuardSurfaceTarget)
            || typeof row.measuredOn !== 'string' || !DATE.test(row.measuredOn)
            || row.measuredVersion !== null && (typeof row.measuredVersion !== 'string' || !VERSION.test(row.measuredVersion))
            || typeof row.provenance !== 'string' || !Array.isArray(row.files) || !row.files.every(validFile) || !validReadonly(row.readonly)
            || row.capability === 'unavailable' && (row.evidenceStatus !== 'not_applicable' || row.files.length !== 0)
            || row.capability === 'instructed' && (row.evidenceStatus !== 'pending_evidence' || row.files.length !== 1)
            || row.capability !== 'unavailable' && row.capability !== 'instructed') return undefined
        seen.add(row.target as GuardSurfaceTarget)
    }
    const result = captured as unknown as RestrictionExpansionComplete
    return outputWithinLimits(result) ? result : undefined
}

export function compareRestrictionOutputs(expectedInput: unknown, actualInput: unknown) {
    const expected = validExpansion(expectedInput)
    const actual = validExpansion(actualInput)
    if (!expected || !actual) return refusal('RESTRICTION_INPUT_INVALID', 'restriction comparison requires two bounded complete expansions')
    const actualTargets = new Map(actual.targets.map((row) => [row.target, row]))
    const staleTargets: GuardSurfaceTarget[] = []
    const currentTargets: GuardSurfaceTarget[] = []
    for (const row of expected.targets) {
        const actualRow = actualTargets.get(row.target)
        if (JSON.stringify(row) === JSON.stringify(actualRow)) currentTargets.push(row.target)
        else staleTargets.push(row.target)
    }
    return frozen({
        kind: 'complete', currentTargets, staleTargets,
        sharedGuardCurrent: JSON.stringify(expected.sharedGuard) === JSON.stringify(actual.sharedGuard),
    }) ?? refusal('RESTRICTION_OUTPUT_LIMIT', 'restriction comparison output exceeds bounded JSON limits')
}
