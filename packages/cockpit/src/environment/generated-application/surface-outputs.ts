import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parseDocument } from 'yaml'
import { SURFACE_TARGETS, type SurfaceFeature, type SurfaceSourceFile, type SurfaceTarget } from '../../surfaces/contract.js'
import { harnessFact, isGuardSurfaceTarget } from '../../surfaces/harness-registry.js'
import { RULESYNC_VERSION, type SurfaceGenerationOutcome } from '../../surfaces/generator-adapter.js'
import { hasTargetMcpServers, type McpCollectionOutcome, type McpHarnessServer } from '../../surfaces/mcp.js'
import { codexWritableRoot, shippedInstructionCapabilities } from '../../surfaces/projection.js'
import { surfaceModelSha256, type NativeFragmentSet } from '../../surfaces/render.js'
import { GUARD_LOCAL_PATHS } from '../../guards/local-identity.js'
import { claudeGuardFileDenials, openCodeGuardFileDenials } from '../../surfaces/guard-file-protection.js'
import { RefusalError, tryParseJson } from '../contract.js'
import { compareCodeUnits, ownRecord, sha256 } from './shared.js'
import { splitRepositoryPath } from '../../repository-path.js'

export function expectedSurfaceOutputs(
    tools: readonly SurfaceTarget[],
    features: readonly SurfaceFeature[],
    sources: readonly SurfaceSourceFile[],
): Readonly<Partial<Record<SurfaceTarget, readonly string[]>>> {
    const has = (feature: SurfaceFeature) => features.includes(feature)
    const hasFor = (target: SurfaceTarget, feature: SurfaceFeature) => has(feature)
        && harnessFact(target).rulesyncFeatures.some(candidate => candidate === feature)
    const names = (prefix: string, suffix: string) => sources.filter(source => source.path.startsWith(prefix))
        .map(source => source.path.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length))
    const skills = sources.filter(source => source.path.startsWith('skills/')).map(source => source.path.slice('skills/'.length))
    const permissionRulesForTarget = (target: 'codexcli' | 'grokcli') => {
        const permissionSource = sources.find(source => source.path === 'permissions.jsonc')
        if (!permissionSource) return false
        const source = ownRecord(JSON.parse(permissionSource.bytes))
        const sections = [ownRecord(source?.permission), ownRecord(ownRecord(source?.[target])?.permission)]
        return sections.some(permission => permission !== undefined && Object.values(permission).some(value => {
            const rules = ownRecord(value)
            return rules !== undefined && Object.keys(rules).length > 0
        }))
    }
    const rows = Object.fromEntries(SURFACE_TARGETS.map(target => [target, []])) as unknown as Record<SurfaceTarget, string[]>
    if (has('rules')) for (const target of SURFACE_TARGETS) {
        if (!hasFor(target, 'rules')) continue
        const root = harnessFact(target).outputs.instruction
        if (target === 'cursor') rows[target].push(...names('rules/', '.md').map(name => `${root}/${name}.mdc`))
        else rows[target].push(root)
    }
    if (has('mcp')) for (const target of SURFACE_TARGETS) {
        if (hasFor(target, 'mcp') && hasTargetMcpServers(sources, target)) rows[target].push(harnessFact(target).outputs.mcp)
    }
    if (has('hooks')) rows.claudecode.push('.claude/settings.json'), rows.codexcli.push('.codex/hooks.json'), rows.opencode.push('.opencode/plugins/rulesync-hooks.js')
    if (has('hooks')) rows.cursor.push('.cursor/hooks.json'), rows.grokcli.push('.grok/hooks/rulesync.json')
    if (has('permissions')) for (const target of SURFACE_TARGETS) {
        if (!hasFor(target, 'permissions')) continue
        if ((target !== 'codexcli' && target !== 'grokcli') || permissionRulesForTarget(target)) {
            rows[target].push(...harnessFact(target).outputs.permissions)
        }
    }
    if (has('subagents')) for (const name of names('subagents/', '.md')) {
        rows.claudecode.push(`.claude/agents/${name}.md`)
        rows.codexcli.push(`.codex/agents/${name}.toml`)
        rows.opencode.push(`.opencode/agents/${name}.md`)
        rows.cursor.push(`.cursor/agents/${name}.md`)
        rows.grokcli.push(`.grok/agents/${name}.md`)
    }
    if (has('skills')) for (const path of skills) {
        rows.claudecode.push(`.claude/skills/${path}`)
        rows.codexcli.push(`.agents/skills/${path}`)
        const source = sources.find(candidate => candidate.path === `skills/${path}`)
        if (path.endsWith('/SKILL.md') && source && expectsCodexSkillSidecar(source.bytes)) {
            rows.codexcli.push(`.agents/skills/${path.slice(0, -'SKILL.md'.length)}agents/openai.yaml`)
        }
        rows.opencode.push(`.opencode/skills/${path}`)
        rows.cursor.push(`.cursor/skills/${path}`)
        rows.grokcli.push(`.grok/skills/${path}`)
    }
    return Object.fromEntries(tools.map(target => [target, [...new Set(rows[target])].sort(compareCodeUnits)])) as Readonly<Partial<Record<SurfaceTarget, readonly string[]>>>
}

export function expectedClaudePluginOutputs(
    features: readonly SurfaceFeature[],
    sources: readonly SurfaceSourceFile[],
): readonly string[] {
    const rows: string[] = []
    if (features.includes('mcp')) rows.push('.mcp.json')
    if (features.includes('hooks')) rows.push('hooks/hooks.json')
    if (features.includes('subagents')) for (const source of sources.filter(row => row.path.startsWith('subagents/'))) {
        rows.push(`agents/${source.path.slice('subagents/'.length)}`)
    }
    if (features.includes('skills')) for (const source of sources.filter(row => row.path.startsWith('skills/'))) {
        rows.push(source.path)
    }
    return [...new Set(rows)].sort(compareCodeUnits)
}

export function claudePluginManifest(): Readonly<{ bytes: string; sha256: string }> {
    const bytes = `${JSON.stringify({
        name: 'cockpit-surfaces',
        description: 'Generated cockpit agent surfaces.',
    }, null, 2)}\n`
    return { bytes, sha256: sha256(bytes) }
}

// A rules overlay is written into the instruction file every harness loads at start, so Rulesync
// must see it as a root rule. A rule that already says `root: false` (Rulesync's default spelling)
// is still always loaded; one that narrows itself with `globs` cannot be, so it is refused by name
// rather than published as a rule that silently applies everywhere.
export function alwaysLoadedRule(bytes: string): Readonly<{ kind: 'complete'; bytes: string }> | Readonly<{ kind: 'refusal'; reason: string }> {
    if (!bytes.startsWith('---\n')) return { kind: 'complete', bytes: `---\nroot: true\ntargets: ["*"]\n---\n${bytes}` }
    const end = bytes.indexOf('\n---\n', 4)
    if (end < 0) return { kind: 'refusal', reason: 'opens a frontmatter block that never closes with a `---` line' }
    const document = parseDocument(bytes.slice(4, end + 1), { uniqueKeys: true })
    const frontmatter: unknown = document.errors.length === 0 ? document.toJS({ maxAliasCount: 0 }) : undefined
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
        return { kind: 'refusal', reason: 'has frontmatter that is not a YAML mapping' }
    }
    const { globs } = frontmatter as Record<string, unknown>
    if (globs !== undefined && !(Array.isArray(globs) && globs.every(glob => glob === '**/*' || glob === '**'))) {
        return { kind: 'refusal', reason: 'limits itself to files with `globs`, but cockpit writes rules overlays into the instruction file every harness loads for every file' }
    }
    document.set('root', true)
    if (!document.has('targets')) document.set('targets', ['*'])
    return { kind: 'complete', bytes: `---\n${document.toString()}---\n${bytes.slice(end + 5)}` }
}

function expectsCodexSkillSidecar(bytes: string): boolean {
    if (!bytes.startsWith('---\n')) return false
    const end = bytes.indexOf('\n---\n', 4)
    if (end < 0) return false
    let frontmatter: unknown
    try {
        const document = parseDocument(bytes.slice(4, end), { uniqueKeys: true })
        if (document.errors.length > 0) return false
        frontmatter = document.toJS({ maxAliasCount: 0 }) as unknown
    } catch { /* unparseable input is malformed; the caller refuses it. */ return false }
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return false
    const codexcli = (frontmatter as Record<string, unknown>).codexcli
    if (!codexcli || typeof codexcli !== 'object' || Array.isArray(codexcli)) return false
    const metadata = codexcli as Record<string, unknown>
    const sections = ['interface', 'policy', 'dependencies'].map(key => metadata[key])
    const records = sections.filter((section): section is Record<string, unknown> =>
        section !== null && typeof section === 'object' && !Array.isArray(section))
    return records.some(section => Object.keys(section).length > 0)
        || records.length > 0 && typeof metadata['short-description'] === 'string'
}

export function emptyGeneration(): Extract<SurfaceGenerationOutcome, { kind: 'complete' }> {
    return {
        kind: 'complete', status: 0, diagnostics: [] as readonly [],
        mechanism: { package: 'rulesync', version: RULESYNC_VERSION, role: 'spelling' },
        files: [],
    }
}

/**
 * Claude Code's native Read, Grep and Glob tools never reach the guard hook, so the read denial the
 * hook applies to shell commands is restated as Claude `Read` deny rules for every declared
 * instance, mounted or not: an instance is readable by the native tools whether or not a directory
 * grant names its sibling, and an earlier rule set that followed grants left host-mounted and root
 * instances readable. Siblings sit outside the project root, where neither `./`, `/..` nor `../`
 * rules match and an absolute path would differ per clone, so each rule is anchored with `//**` on
 * the sibling-relative suffix; an instance in the cockpit root itself is anchored at the project
 * root with `/`. Measured on Claude Code 2.1.314, 2026-10-30, with an unruled control file beside
 * them: `//**` rules refused Read and Grep of sibling instances and of nested `.secrets` files, and
 * `/` rules refused root files, while the control stayed readable. Over-matching a deny is safe;
 * glob metacharacters in a path become `?` so a literal bracket cannot narrow the rule.
 *
 * Every `.env` and `.env.*` file is denied too. Claude's filesystem-root deny rules cannot carve out
 * the documentation names the guard exempts. Native file tools and recognized shell reads refuse
 * those names; a guard approval cannot override the native denial. Measured on Claude Code 2.1.322,
 * 2026-11-12: a `!` rule carves only out of cwd-relative rules, never `//**` ones, and a character
 * class reads `!` literally, so the only `//**` set that spared `.env.schema` was positive ranges,
 * which leave readable any suffix character they do not list. Keep the broad protection until a
 * supported exception can preserve instance denials across sibling directories.
 */
function claudeReadDenials(
    siblings: readonly { slug: string; path: string }[],
    instances: readonly { slug: string; path: string }[],
    secretPaths: readonly string[] = [],
): readonly string[] {
    const rules = ['//**/.secrets/**', '//**/.env', '//**/.env.*', ...instanceReadPaths(siblings, instances).flatMap(claudePathRules),
        ...claudeSecretPathDenials(siblings, secretPaths)]
    return [...new Set(rules)].sort(compareCodeUnits)
}

/**
 * A path's rule under both Unicode normal forms. Claude Code matches rules case-insensitively but
 * compares Unicode spellings literally, while APFS resolves either form to the same file: measured on
 * Claude Code 2.1.322, macOS, 2026-11-12, a rule spelled NFD let the Read tool return the file asked
 * for in NFC, while upper- and mixed-case spellings of a ruled path were refused.
 */
function claudePathRules(row: Readonly<{ inRoot: boolean; path: string }>): readonly string[] {
    const literal = row.path.replace(/[*?[\]\\!#()]/g, '?')
    return [...new Set([literal.normalize('NFC'), literal.normalize('NFD')])].map(spelling => row.inRoot ? `/${spelling}` : `//**/${spelling}`)
}

/**
 * `[guards] secret_paths`, spelled as Claude Code rules the way an instance is: the path itself and
 * everything below it, since a declared secret path may be a file or a directory. Claude Code's Read,
 * Grep and Glob never reach the guard hook, and its Edit and Write do, so each path is denied to both
 * the read and the edit rules: the hook still refuses an edit if a rule is missing, the rule refuses a read the hook never sees.
 */
function claudeSecretPathDenials(siblings: readonly { slug: string; path: string }[], secretPaths: readonly string[]): readonly string[] {
    return declaredSecretPaths(siblings, secretPaths).flatMap(row => claudePathRules(row).flatMap(rule => [rule, `${rule}/**`]))
}

/** Each declared secret path by the path that is the same in every clone, as an instance's is. */
function declaredSecretPaths(siblings: readonly { slug: string; path: string }[], secretPaths: readonly string[]): readonly Readonly<{ inRoot: boolean; path: string }>[] {
    return secretPaths.map(declared => {
        const { slug, path } = splitRepositoryPath(declared)
        if (slug === undefined) return { inRoot: true, path }
        const sibling = siblings.find(row => row.slug === slug)
        if (!sibling) throw new RefusalError(`secret path ${declared} names sibling ${slug}, whose directory was not authenticated`)
        const suffix = [...sibling.path.split('/'), ...path.split('/')].filter(part => part !== '..' && part !== '.' && part !== '')
        return sibling.path === '' ? { inRoot: true, path } : { inRoot: false, path: suffix.join('/') }
    })
}

/**
 * Each declared instance by the path that is the same in every clone: relative to the cockpit root
 * for an instance there, otherwise the sibling-relative suffix with `..` and `.` segments dropped.
 */
function instanceReadPaths(
    siblings: readonly { slug: string; path: string }[],
    instances: readonly { slug: string; path: string }[],
): readonly Readonly<{ inRoot: boolean; path: string }>[] {
    return instances.map(instance => {
        const sibling = siblings.find(row => row.slug === instance.slug)
        if (!sibling) throw new RefusalError(`declared instance ${instance.path} names sibling ${instance.slug}, whose directory was not authenticated`)
        if (sibling.path === '') return { inRoot: true, path: instance.path }
        const suffix = [...sibling.path.split('/'), ...instance.path.split('/')].filter(part => part !== '..' && part !== '.' && part !== '')
        return { inRoot: false, path: suffix.join('/') }
    })
}

const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json'

/**
 * OpenCode's native read tool asks its `read` permission with the file path relative to the Git
 * worktree, and its `*` matches across `/`, so each protected path is denied both as written and
 * below any prefix: that covers a cockpit root nested in a larger repository and siblings reached
 * through `../`. Only `*` and `?` are pattern characters there; either one in a path becomes `?`,
 * which over-matches a deny and so stays safe. The plugin's guard routing refuses the same reads,
 * case-folded; these rules still deny the declared spellings when the plugin cannot load.
 */
export function openCodeReadDenials(
    siblings: readonly { slug: string; path: string }[],
    instances: readonly { slug: string; path: string }[],
    secretPaths: readonly string[] = [],
): readonly string[] {
    const literal = (path: string) => path.replace(/[*?]/g, '?')
    const paths = ['.secrets/*', ...instanceReadPaths(siblings, instances).map(row => literal(row.path)),
        ...declaredSecretPaths(siblings, secretPaths).flatMap(row => [literal(row.path), `${literal(row.path)}/*`])]
    return [...new Set(paths.flatMap(path => [path, `*/${path}`]))].sort(compareCodeUnits)
}

/** The machine-local file `sync` writes with a sibling's absolute directory, for OpenCode to read. */
export function openCodeGrantFile(slug: string): string {
    return `${GUARD_LOCAL_PATHS.directory}/opencode-grant-${slug}`
}

// OpenCode matches `external_directory` patterns against absolute paths and has no token for the
// project root, so `../api/**` never matches (measured with OpenCode 1.19.4 on 2026-11-02). The
// committed pattern names a machine-local file instead; OpenCode substitutes `{file:...}` relative
// to the config file, and refuses to start, naming the file, while it is missing.
function openCodeExternalDirectories(grants: readonly Readonly<{ slug: string; target: SurfaceTarget }>[]): Readonly<Record<string, 'allow'>> {
    return Object.fromEntries([...new Set(grants.filter(grant => grant.target === 'opencode')
        .map(grant => `{file:${openCodeGrantFile(grant.slug)}}/**`))].sort(compareCodeUnits).map(pattern => [pattern, 'allow' as const]))
}

// The cockpit commands the shipped skills tell an agent to run and the guard admits without a
// prompt. Claude Code allows nothing in its default mode without a rule, so a headless session was
// denied even `test-run` from its own skill. A rule only lets Claude run the command without asking:
// the guard hook still runs first, and its ask or deny wins over the rule, so a command whose
// decider the [work.gates] or [autonomy] policy makes a person still asks. Commands that are always
// a person's (`init`, `sibling add`) are left out so they keep asking; `down` keeps the data volumes. Measured with Claude Code 2.1.316 on 2026-11-02 beside an unruled control: `Bash(<prefix> *)`
// ran a matching command headless, the control and a chain with an unmatched part were denied, a hook
// `ask` denied a matching command, and Claude ignores these rules until a person trusts the workspace.
const AGENT_COCKPIT_COMMANDS = [
    'check *', 'confirm *', 'doctor *', 'preflight *', 'logs *', 'ps *', 'restart *', 'rebuild *', 'exec *', 'sync *', 'reset * --apply', 'up *', 'sleep *', 'down *',
    'runtime measure *', 'test-run *',
    'work status *', 'work accept *', 'work check *', 'work note *', 'work decide *', 'work answer *', 'work acknowledge *', 'work grade *', 'work signoff *', 'work retry *', 'work recover *',
    'work verify *', 'grade *', 'upgrade *', 'docs check *', 'env keys *', 'env schema *', 'use *', 'pull *', 'stacks *',
    'browser drive *', 'browser screenshot *',
] as const

function claudeCommandAllowances(): Readonly<Record<string, 'allow'>> {
    return Object.fromEntries(['npx --no cockpit', './node_modules/.bin/cockpit', './node_modules/@b00dea/cockpit/bin/cockpit.mjs']
        .flatMap(launcher => AGENT_COCKPIT_COMMANDS.map(command => [`${launcher} ${command}`, 'allow' as const])))
}

// What each harness loads at start, from the dated instruction-loading runs. Claude Code applies a
// scoped rule only to matching files, so a scoped source counts separately there.
export const GUIDE_LOAD_CHARACTERIZATIONS = Object.freeze(Object.fromEntries(shippedInstructionCapabilities()
    .filter(fact => isGuardSurfaceTarget(fact.target))
    .map(fact => [fact.target, {
        measuredOn: fact.characterizedOn, metric: 'lines' as const, scopeSemantics: fact.target === 'claudecode' ? 'conditional' as const : 'full' as const,
        provenance: fact.provenance,
    }])))

export function nativeSources(
    mcp: Extract<McpCollectionOutcome, { kind: 'complete' }>,
    grants: readonly { slug: string; target: SurfaceTarget; path: string }[],
    siblings: readonly { slug: string; path: string }[],
    instances: readonly { slug: string; path: string }[],
    secretPaths: readonly string[] = [],
): readonly SurfaceSourceFile[] {
    const sources: SurfaceSourceFile[] = []
    const transports = mcp.result.harnesses.flatMap(row => row.servers)
    // A remote server no listed tool can carry is left out of the source entirely.
    const written = mcp.result.servers.flatMap(model => transports.filter(server => server.name === model.name).slice(0, 1))
    if (written.length > 0) {
        const native = (server: McpHarnessServer, helperKey: 'headersHelper' | 'http_headers_helper') => 'url' in server
            ? { type: 'http', url: server.url, ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
                ...(server.headersHelper === null ? {} : { [helperKey]: server.headersHelper }), disabled: !server.enabled }
            : { type: 'stdio', command: server.command, args: server.args, disabled: !server.enabled }
        const servers = Object.fromEntries(written.map(server => [server.name, native(server, 'headersHelper')]))
        const targets = Object.fromEntries(mcp.result.harnesses.flatMap(row => {
            const removed = written.filter(server => !row.servers.some(transport => transport.name === server.name))
                .map(server => [server.name, null] as const)
            // Codex spells Claude Code's headersHelper http_headers_helper; Rulesync passes an unknown
            // key through to config.toml unchanged.
            const respelled = row.target === 'codexcli'
                ? row.servers.filter(server => server.allowedTools !== undefined || 'url' in server && server.headersHelper !== null)
                    .map(server => [server.name, { ...native(server, 'http_headers_helper'),
                        ...(server.allowedTools === undefined ? {} : { enabled_tools: server.allowedTools }) }] as const)
                : []
            return removed.length + respelled.length > 0 ? [[harnessFact(row.target).rulesyncTarget, {
                mcpServers: Object.fromEntries([...removed, ...respelled]),
            }]] : []
        }))
        sources.push({ path: 'mcp.jsonc', bytes: `${JSON.stringify({ mcpServers: servers, ...targets }, null, 2)}\n` })
    }
    const paths = (target: SurfaceTarget) => [...new Set(grants.filter(grant => grant.target === target).map(grant => grant.path))].sort(compareCodeUnits)
    const claudeServers = mcp.result.harnesses.find(row => row.target === 'claudecode')?.servers ?? []
    const enabledMcpjsonServers = claudeServers.filter(server => server.enabled).map(server => server.name).sort()
    // Claude Code ignores `disabled` in `.mcp.json` and offers an unlisted server for one-click
    // approval; only this list keeps it off (measured with Claude Code 2.1.316 on 2026-11-02).
    const disabledMcpjsonServers = claudeServers.filter(server => !server.enabled).map(server => server.name).sort()
    sources.push({ path: 'permissions.jsonc', bytes: `${JSON.stringify({
        permission: {},
        claudecode: {
            permission: {
                read: Object.fromEntries(claudeReadDenials(siblings, instances, secretPaths).map(rule => [rule, 'deny'])),
                edit: Object.fromEntries([...claudeGuardFileDenials(), ...claudeSecretPathDenials(siblings, secretPaths)].map(rule => [rule, 'deny'])),
                bash: claudeCommandAllowances(),
            },
            permissions: { additionalDirectories: paths('claudecode') },
            enabledMcpjsonServers,
            ...(disabledMcpjsonServers.length > 0 ? { disabledMcpjsonServers } : {}),
        },
        opencode: {
            permission: { external_directory: openCodeExternalDirectories(grants) },
        },
        cursor: {
            permission: {
                read: Object.fromEntries(paths('cursor').map(path => [`${path}/**`, 'allow'])),
                write: Object.fromEntries(paths('cursor').map(path => [`${path}/**`, 'allow'])),
            },
        },
        grokcli: {
            permission: {
                read: Object.fromEntries(paths('grokcli').map(path => [`${path}/**`, 'allow'])),
                edit: Object.fromEntries(paths('grokcli').map(path => [`${path}/**`, 'allow'])),
            },
        },
    }, null, 2)}\n` })
    return sources
}

export function nativeFragmentSet(
    generated: Extract<SurfaceGenerationOutcome, { kind: 'complete' }>,
    model: unknown,
    paths: Readonly<Partial<Record<SurfaceTarget, string>>>,
): NativeFragmentSet | undefined {
    const modelSha256 = surfaceModelSha256(model)
    if (!modelSha256) return undefined
    const fragments = Object.entries(paths).map(([target, path]) => {
        const row = generated.files.find(candidate => candidate.target === target && candidate.path === path)
        return row ? { target: target as SurfaceTarget, path, baseSha256: row.sha256, bytes: row.bytes, sha256: row.sha256 } : undefined
    })
    if (fragments.some(fragment => fragment === undefined)) return undefined
    return { modelSha256, fragments: fragments as NonNullable<typeof fragments[number]>[] }
}

export function nativeGrantFragmentSet(
    generated: Extract<SurfaceGenerationOutcome, { kind: 'complete' }>,
    grants: readonly Readonly<{ slug: string; target: SurfaceTarget; path: string }>[],
    paths: Readonly<Partial<Record<SurfaceTarget, string>>>,
    openCodeReads: readonly string[],
): NativeFragmentSet | undefined {
    const modelSha256 = surfaceModelSha256(grants)
    if (!modelSha256) return undefined
    const fragments = Object.entries(paths).map(([target, path]) => {
        const row = generated.files.find(candidate => candidate.target === target && candidate.path === path)
        if (target !== 'opencode' && target !== 'codexcli') {
            return row ? { target: target as SurfaceTarget, path, baseSha256: row.sha256, bytes: row.bytes, sha256: row.sha256 } : undefined
        }
        if (target === 'codexcli') {
            let base: Record<string, unknown> = {}
            if (row) {
                try {
                    const parsed = ownRecord(parseToml(row.bytes))
                    if (!parsed) return undefined
                    base = parsed
                } catch { /* unparseable input is malformed; the caller refuses it. */ return undefined }
                if (['sandbox_mode', 'sandbox_workspace_write', 'default_permissions', 'permissions']
                    .some(key => Object.hasOwn(base, key))) return undefined
            }
            // Codex permission profiles reject the `..` segment required by a portable sibling
            // grant. Publish the core-owned workspace-write settings alone: mixing the legacy
            // sandbox with a generated profile would make Codex ignore that profile.
            // Codex resolves a relative writable root against the directory of the config file,
            // `.codex/`, not the cockpit root (measured with Codex 0.166.0 on 2026-11-02).
            const writableRoots = [...new Set(grants.filter(grant => grant.target === target)
                .map(grant => codexWritableRoot(grant.path)))].sort(compareCodeUnits)
            const bytes = stringifyToml({ ...base, sandbox_mode: 'workspace-write', sandbox_workspace_write: { writable_roots: writableRoots } })
            return { target: target as SurfaceTarget, path, baseSha256: row?.sha256 ?? sha256(''), bytes, sha256: sha256(bytes) }
        }
        let base: Record<string, unknown> = {}
        if (row) {
            const parsed = ownRecord(tryParseJson(row.bytes))
            if (!parsed) return undefined
            base = parsed
            if (Object.hasOwn(base, 'permission')) return undefined
        }
        const externalDirectory = openCodeExternalDirectories(grants)
        const read = Object.fromEntries(openCodeReads.map(rule => [rule, 'deny']))
        const edit = Object.fromEntries(openCodeGuardFileDenials().map(rule => [rule, 'deny']))
        // OpenCode writes `$schema` into a project config that lacks it at every start, which put an
        // unowned member before the owned region; supplying OpenCode's exact value leaves it untouched.
        const bytes = `${JSON.stringify({ $schema: OPENCODE_CONFIG_SCHEMA, ...base, permission: { external_directory: externalDirectory, read, edit } }, null, 2)}\n`
        return { target: target as SurfaceTarget, path, baseSha256: row?.sha256 ?? sha256(''), bytes, sha256: sha256(bytes) }
    })
    if (fragments.some(fragment => fragment === undefined)) return undefined
    return { modelSha256, fragments: fragments as NonNullable<typeof fragments[number]>[] }
}

export function bindNativeGrantsToMcp(
    mcp: NativeFragmentSet,
    grants: NativeFragmentSet,
): NativeFragmentSet | undefined {
    const replacements = new Map<string, NativeFragmentSet['fragments'][number]>()
    for (const base of mcp.fragments) {
        const grant = grants.fragments.find(fragment => fragment.target === base.target && fragment.path === base.path)
        if (!grant) continue
        if (grant.baseSha256 !== base.sha256) return undefined
        replacements.set(`${base.target}\0${base.path}`, grant)
    }
    return { ...mcp, fragments: mcp.fragments.map(fragment => {
        const grant = replacements.get(`${fragment.target}\0${fragment.path}`)
        return grant ? { ...fragment, bytes: grant.bytes, sha256: grant.sha256 } : fragment
    }) }
}

export function nativeMcpPaths(targets: readonly SurfaceTarget[]): Readonly<Partial<Record<SurfaceTarget, string>>> {
    return Object.fromEntries(targets.map(target => [target, harnessFact(target).outputs.mcp]))
}

/**
 * Whether every stale path is the MCP file of a tool still listed. Such a file goes stale only because
 * none of its servers are written any more, so removing it can only narrow access. A file that also
 * holds a tool's permissions can go stale for another reason, so it is not one of these. Publication has
 * already refused a stale path whose bytes differ from what cockpit generated.
 */
export function staleMcpOutputsOnly(paths: readonly string[], configuredHarnesses: readonly string[]): boolean {
    const removable = SURFACE_TARGETS.filter(target => configuredHarnesses.includes(target)).map(target => harnessFact(target).outputs)
        .filter(outputs => !outputs.permissions.some(path => path === outputs.mcp)).map(outputs => outputs.mcp as string)
    return paths.length > 0 && paths.every(path => removable.includes(path))
}

export function nativeGrantPaths(targets: readonly SurfaceTarget[]): Readonly<Partial<Record<SurfaceTarget, string>>> {
    return Object.fromEntries(targets.map(target => [target, harnessFact(target).outputs.permissions[0]]))
}
