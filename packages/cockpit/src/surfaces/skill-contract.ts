import { createHash } from 'node:crypto'
import { parseDocument, visit } from 'yaml'

import { commandSpelling, commands } from '../command-table.js'
import { stripDevelopmentMarkers } from './development-markers.js'
import { snapshotGeneratedJson, snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
import {
    type SurfaceGenerationDiagnostic,
    generateSurfaceBatch,
    type SurfaceGenerationOutcome,
    type SurfaceGenerationWarning,
} from './generator-adapter.js'
import {
    SURFACE_TARGETS,
    SURFACE_OUTPUT_MAX_FILES,
    bundleSurfaceFiles,
    surfaceSourcesMatchFeature,
    type RenderedSurfaceFile,
    type SurfaceSourceFile,
    type SurfaceTarget,
} from './contract.js'
import { GUARD_SURFACE_TARGETS, harnessFact, type GuardSurfaceTarget } from './harness-registry.js'
import { exactKeys } from '../exact-keys.js'

/** The skill `cockpit init` installs first; init and the reference renderer both address it by this name. */
export const SHIPPED_SETUP_SKILL = 'cockpit-setup' as const

export interface SkillContractDiagnostic {
    readonly severity: 'error'
    readonly code: string
    readonly message: string
    readonly target?: string
}

export interface SkillStandingCost {
    readonly target: SurfaceTarget
    readonly metric: 'frontmatter_bytes'
    readonly value: number
    readonly cap: number
    readonly status: 'within_cap' | 'exceeded'
}

export interface AdmittedSkillCollection {
    readonly source: Readonly<{ path: string; sha256: string }>
    readonly skills: readonly string[]
    readonly metric: 'frontmatter_bytes'
    readonly caps: Readonly<Record<SurfaceTarget, number>>
    /** The packaged procedures of the shipped skills, each read on demand by the skill that names it. */
    readonly procedures: readonly Readonly<{ path: string; sha256: string; loading: 'pull'; budget: 'uncapped' }>[]
    readonly entrypoints: readonly Readonly<{ path: string; cap: number; metric: 'lines'; displacement: string }>[]
}

export type SkillContractResult =
    | Readonly<{
        kind: 'complete'
        status: 0
        diagnostics: readonly []
        skills: readonly string[]
        costs: readonly SkillStandingCost[]
        collection: AdmittedSkillCollection
        files: readonly RenderedSurfaceFile[]
    }>
    | Readonly<{
        kind: 'refusal'
        status: 2
        diagnostics: readonly SkillContractDiagnostic[]
        files: readonly []
    }>
    | Readonly<{
        kind: 'unavailable'
        status: 3
        diagnostics: readonly SkillContractDiagnostic[]
        files: readonly []
    }>

export type SkillStandingExtensionResult = Readonly<{
    kind: 'complete'
    status: 0
    diagnostics: readonly []
    skills: readonly string[]
    costs: readonly SkillStandingCost[]
    inventorySha256: string
}> | Extract<SkillContractResult, { kind: 'refusal' }>

export type InspectedBootstrapOutputs = Readonly<{
    kind: 'complete'
    target: SurfaceTarget
    skill: typeof SHIPPED_SETUP_SKILL
    files: readonly RenderedSurfaceFile[]
}>

export type InspectedSkillOutputProjection = InspectedBootstrapOutputs | Readonly<{
    kind: 'refusal'
    status: 2
    diagnostics: readonly SkillContractDiagnostic[]
    files: readonly []
}>

const inspectedSkillResults = new WeakMap<object, Readonly<Partial<Record<SurfaceTarget, readonly string[]>>>>()
const inspectedBootstrapOutputs = new WeakSet<object>()

export function isInspectedBootstrapOutputs(value: unknown): value is InspectedBootstrapOutputs {
    return typeof value === 'object' && value !== null && inspectedBootstrapOutputs.has(value)
}

interface CapturedInput {
    readonly sources: readonly SurfaceSourceFile[]
    readonly declaredExtensions: readonly string[]
    readonly collection: Readonly<{ path: string; bytes: string; sha256: string }>
    readonly procedures: readonly Readonly<{ path: string; bytes: string; sha256: string }>[]
    readonly authority: Readonly<{ skills: readonly string[]; metric: 'frontmatter_bytes'; caps: Readonly<Record<SurfaceTarget, number>> }>
}

interface CapturedRenderedInput extends CapturedInput {
    readonly generated: Extract<SurfaceGenerationOutcome, { kind: 'complete' }>
    /** The tools sync renders; only their skill copies are inspected and costed. */
    readonly targets: readonly SurfaceTarget[]
}

interface SkillDeclaration {
    readonly name: string
    readonly procedure: string
    readonly cap: number
}

const DESCRIPTION_MAX_BYTES = 512
const ENTRY_POINT_MAX_LINES = 32
const INSTALLED_SET_CAP_MAX_BYTES = 65_536
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COMMAND = /`cockpit\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g
const INLINE_NUMBERED_STEP = /^\s*\d+[.)]\s+/m
const INLINE_FENCE = /^\s*```/m
const COPIED_DECISION_LOGIC = /(?:\bparse\w*\s+(?:the\s+)?(?:registry|cockpit\.toml)|\bTOML\.parse\b|^\s*\[[a-z][a-z0-9_.-]*\]\s*$|\|\s*(?:tier|mount|data mode|verdict)\s*\|)/im
const MISLEADING_COMPLETION = /\b(?:report|declare|claim)\w*\s+(?:the\s+)?(?:work\s+)?(?:complete|successful|green)\s+without\b/i
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(commands.map(command => command.name))
const TARGET_PATH_PREFIX: Readonly<Record<SurfaceTarget, string>> = Object.freeze(Object.fromEntries(
    SURFACE_TARGETS.map(target => [target, harnessFact(target).outputs.skills]),
)) as Readonly<Record<SurfaceTarget, string>>

function object(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value: JsonSnapshot | undefined): readonly string[] | undefined {
    return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0)
        && new Set(value).size === value.length ? value as readonly string[] : undefined
}

function refusal(code: string, message: string, target?: string): Extract<SkillContractResult, { kind: 'refusal' }> {
    return {
        kind: 'refusal' as const,
        status: 2 as const,
        diagnostics: [{ severity: 'error' as const, code, message, ...(target ? { target } : {}) }],
        files: [] as readonly [],
    }
}

const PROCEDURE_ASSET = /^skills\/procedures\/[a-z0-9][a-z0-9-]*\.md$/

function authenticatedAsset(value: JsonSnapshot | undefined, path: string | RegExp): value is JsonSnapshotObject & { path: string; bytes: string; sha256: string } {
    return object(value) && exactKeys(value, ['path', 'bytes', 'sha256']) && typeof value.path === 'string'
        && (typeof path === 'string' ? value.path === path : path.test(value.path))
        && typeof value.bytes === 'string' && Buffer.byteLength(value.bytes) <= 65_536
        && typeof value.sha256 === 'string' && createHash('sha256').update(value.bytes).digest('hex') === value.sha256
}

function captureInput(input: unknown): CapturedInput | undefined {
    const captured = snapshotJson(input)
    if (!object(captured) || !exactKeys(captured, ['sources', 'collection', 'procedures',
        ...(Object.hasOwn(captured, 'declaredExtensions') ? ['declaredExtensions'] : [])]) || !Array.isArray(captured.sources)
        || !authenticatedAsset(captured.collection, 'skills/collection.json')
        || !Array.isArray(captured.procedures) || captured.procedures.length === 0 || captured.procedures.length > 16
        || !captured.procedures.every(procedure => authenticatedAsset(procedure, PROCEDURE_ASSET))
        || new Set(captured.procedures.map(procedure => (procedure as JsonSnapshotObject).path)).size !== captured.procedures.length) return undefined
    let authority: JsonSnapshot | undefined
    try {
        authority = snapshotJson(JSON.parse(captured.collection.bytes))
        const json = parseDocument(captured.collection.bytes, { uniqueKeys: true })
        if (json.errors.length > 0 || json.warnings.length > 0) return undefined
    } catch { /* unparseable input is malformed; the caller refuses it. */ return undefined }
    if (!object(authority) || !exactKeys(authority, ['skills', 'metric', 'caps'])
        || !Array.isArray(authority.skills) || !sameStrings(authority.skills, ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work']) || authority.metric !== 'frontmatter_bytes'
        || !object(authority.caps) || !exactKeys(authority.caps, SURFACE_TARGETS)) return undefined
    const caps = authority.caps
    const shippedSkills = authority.skills
    if (SURFACE_TARGETS.some(target => !Number.isSafeInteger(caps[target]) || Number(caps[target]) < 1
        || Number(caps[target]) > INSTALLED_SET_CAP_MAX_BYTES)) return undefined
    const declaredExtensions = Object.hasOwn(captured, 'declaredExtensions') ? captured.declaredExtensions : []
    if (!Array.isArray(declaredExtensions) || declaredExtensions.length > SURFACE_OUTPUT_MAX_FILES
        || declaredExtensions.some((name, index) => typeof name !== 'string' || name.length > 128 || !NAME.test(name)
            || shippedSkills.includes(name) || index > 0 && String(declaredExtensions[index - 1]) >= name)) return undefined
    if (!surfaceSourcesMatchFeature(captured.sources, 'skills')) return undefined
    if (!captured.procedures.every(procedure => pulledProcedure((procedure as JsonSnapshotObject).bytes as string))) return undefined
    return { ...captured, declaredExtensions, authority } as unknown as CapturedInput
}

/** A procedure is read on demand and uncapped, and says something. */
function pulledProcedure(bytes: string): boolean {
    const parsed = parseEntryPoint(bytes)
    return !!parsed && exactKeys(parsed.frontmatter, ['loading', 'budget']) && parsed.frontmatter.loading === 'pull'
        && parsed.frontmatter.budget === 'uncapped' && parsed.body.length > 0
}

function captureRenderedInput(input: unknown): CapturedRenderedInput | undefined {
    // Rendered output carries every target's copy of each procedure, so it outgrows the generic
    // JSON limit with one extra skill; bundleSurfaceFiles below enforces the real output cap.
    const captured = snapshotGeneratedJson(input)
    if (!object(captured) || !exactKeys(captured, ['sources', 'collection', 'procedures', 'generated', 'targets',
        ...(Object.hasOwn(captured, 'declaredExtensions') ? ['declaredExtensions'] : [])])) return undefined
    const targets = Array.isArray(captured.targets) && captured.targets.length > 0
        && captured.targets.every(target => SURFACE_TARGETS.includes(target as SurfaceTarget))
        && new Set(captured.targets).size === captured.targets.length
        ? SURFACE_TARGETS.filter(target => (captured.targets as readonly JsonSnapshot[]).includes(target)) : undefined
    if (!targets) return undefined
    const base = captureInput({ sources: captured.sources, collection: captured.collection, procedures: captured.procedures,
        ...(Object.hasOwn(captured, 'declaredExtensions') ? { declaredExtensions: captured.declaredExtensions } : {}) })
    const generated = captured.generated
    if (!base || !object(generated) || !exactKeys(generated, ['kind', 'status', 'diagnostics', 'mechanism', 'files', 'warnings'])
        || generated.kind !== 'complete' || generated.status !== 0 || !Array.isArray(generated.diagnostics) || generated.diagnostics.length !== 0
        || !object(generated.mechanism) || !exactKeys(generated.mechanism, ['package', 'version', 'role'])
        || generated.mechanism.package !== 'rulesync' || generated.mechanism.version !== '43.1.2' || generated.mechanism.role !== 'spelling'
        || !Array.isArray(generated.files) || !Array.isArray(generated.warnings)
        || !generated.warnings.every((warning): warning is SurfaceGenerationWarning => object(warning)
            && exactKeys(warning, ['severity', 'code', 'target', 'path', 'message']) && warning.severity === 'warning'
            && warning.code === 'SURFACE_GENERATOR_TRUST_WARNING' && SURFACE_TARGETS.includes(warning.target as SurfaceTarget)
            && warning.path === '.claude/settings.json' && typeof warning.message === 'string' && warning.message.length > 0)
        || !bundleSurfaceFiles(generated.files as unknown as readonly RenderedSurfaceFile[])) return undefined
    return { ...base, generated, targets } as unknown as CapturedRenderedInput
}

function parseEntryPoint(bytes: string): { frontmatter: JsonSnapshotObject; body: string; rawFrontmatter: string } | undefined {
    if (!bytes.startsWith('---\n')) return undefined
    const end = bytes.indexOf('\n---\n', 4)
    if (end < 0) return undefined
    const rawFrontmatter = bytes.slice(4, end)
    const document = parseDocument(rawFrontmatter, { uniqueKeys: true })
    if (document.errors.length > 0 || document.warnings.length > 0) return undefined
    let hasAlias = false
    visit(document, { Alias: () => { hasAlias = true; return visit.BREAK } })
    if (hasAlias) return undefined
    const frontmatter = snapshotJson(document.toJS({ maxAliasCount: 0 }))
    if (!object(frontmatter)) return undefined
    return { frontmatter, body: bytes.slice(end + 5).trim(), rawFrontmatter }
}

function targetEquivalences(value: JsonSnapshot | undefined): Readonly<Record<GuardSurfaceTarget, readonly string[]>> | undefined {
    if (!object(value) || !exactKeys(value, GUARD_SURFACE_TARGETS)) return undefined
    const claudecode = strings(value.claudecode)
    const codexcli = strings(value.codexcli)
    const opencode = strings(value.opencode)
    if (!claudecode || !codexcli || !opencode) return undefined
    return { claudecode, codexcli, opencode }
}

function sameStrings(value: JsonSnapshot | undefined, expected: readonly string[]): boolean {
    return Array.isArray(value) && value.length === expected.length
        && value.every((item, index) => item === expected[index])
}

function targetToolsMatch(frontmatter: JsonSnapshotObject, equivalences: Readonly<Record<GuardSurfaceTarget, readonly string[]>>): boolean {
    const claude = frontmatter.claudecode
    const opencode = frontmatter.opencode
    const codex = frontmatter.codexcli
    if (!object(claude) || !exactKeys(claude, ['allowed-tools']) || !sameStrings(claude['allowed-tools'], equivalences.claudecode)
        || !object(opencode) || !exactKeys(opencode, ['allowed-tools']) || !sameStrings(opencode['allowed-tools'], equivalences.opencode)
        || !object(codex) || !exactKeys(codex, ['dependencies'])) return false
    const dependencies = codex.dependencies
    if (!object(dependencies) || !exactKeys(dependencies, ['tools']) || !Array.isArray(dependencies.tools)
        || dependencies.tools.length !== 1 || !object(dependencies.tools[0])) return false
    const executable = dependencies.tools[0]
    return exactKeys(executable, ['type', 'value', 'description']) && executable.type === 'executable'
        && executable.value === 'cockpit' && typeof executable.description === 'string' && executable.description.length > 0
}

function declaration(source: SurfaceSourceFile): SkillDeclaration | SkillContractResult {
    const parsed = parseEntryPoint(source.bytes)
    if (!parsed) return refusal('SKILL_FRONTMATTER_INVALID', 'skill frontmatter is missing, malformed, aliased, duplicated, or unbounded', source.path)
    const { frontmatter, body } = parsed
    if (!exactKeys(frontmatter, ['name', 'description', 'targets', 'cockpit', 'claudecode', 'codexcli', 'opencode'])) {
        return refusal('SKILL_FRONTMATTER_INVALID', 'skill frontmatter contains an unexpected or missing field', source.path)
    }
    const contract = frontmatter.cockpit
    if (!object(contract) || !exactKeys(contract, [
        'commands', 'changes', 'entry-point-lines', 'non-goals', 'procedure', 'review', 'tool-equivalences', 'tools',
    ])) return refusal('SKILL_CONTRACT_INVALID', 'cockpit skill metadata is incomplete', source.path)
    if (typeof frontmatter.name !== 'string' || !NAME.test(frontmatter.name)
        || typeof frontmatter.description !== 'string' || !frontmatter.description.startsWith('Use when ')
        || Buffer.byteLength(frontmatter.description) > DESCRIPTION_MAX_BYTES
        || !Array.isArray(frontmatter.targets) || frontmatter.targets.length !== 1 || frontmatter.targets[0] !== '*') {
        return refusal('SKILL_IDENTITY_INVALID', 'skill name, trigger description, or targets are invalid', source.path)
    }
    const tools = strings(contract.tools)
    const declaredCommands = strings(contract.commands)
    const changes = strings(contract.changes)
    const nonGoals = strings(contract['non-goals'])
    const equivalences = targetEquivalences(contract['tool-equivalences'])
    const review = contract.review
    const entryPointLines = contract['entry-point-lines']
    if (!tools || !declaredCommands || !changes || !nonGoals || !equivalences || typeof contract.procedure !== 'string'
        || !/^procedures\/[a-z0-9][a-z0-9-]*\.md$/.test(contract.procedure)
        || !Number.isSafeInteger(entryPointLines) || Number(entryPointLines) < 1 || Number(entryPointLines) > ENTRY_POINT_MAX_LINES
        || !object(review) || !exactKeys(review, ['mechanical', 'judgment'])
        || typeof review.mechanical !== 'string' || review.mechanical.length === 0
        || review.judgment !== 'accepted' && review.judgment !== 'pending') {
        return refusal('SKILL_CONTRACT_INVALID', 'skill tools, effects, procedure, review, or line cap are invalid', source.path)
    }
    if (!targetToolsMatch(frontmatter, equivalences)) {
        return refusal('SKILL_TOOL_EQUIVALENCE_MISSING', 'skill native tool declarations do not match its equivalence contract', source.path)
    }
    const actualLines = body.length === 0 ? 0 : body.split(/\r?\n/).length
    if (actualLines === 0 || actualLines > Number(entryPointLines) || INLINE_NUMBERED_STEP.test(body) || INLINE_FENCE.test(body)) {
        return refusal('SKILL_ENTRY_POINT_EXCEEDED', 'skill entry point exceeds its declared line cap or embeds a procedure', source.path)
    }
    if (COPIED_DECISION_LOGIC.test(body) || MISLEADING_COMPLETION.test(body)) {
        return refusal('SKILL_DECISION_LOGIC_EMBEDDED', 'skill entry point copies decision logic or makes an unauthenticated completion claim', source.path)
    }
    if (declaredCommands.some(command => !ALLOWED_COMMANDS.has(command))) {
        return refusal('SKILL_COMMAND_UNDECLARED', 'skill declares a command that is not in the cockpit command table', source.path)
    }
    const invoked = [...body.matchAll(COMMAND)].map(match => commandSpelling(match.slice(1).filter(word => word !== undefined)).name ?? match[1]!)
    if (invoked.some(command => !declaredCommands.includes(command) || !ALLOWED_COMMANDS.has(command))) {
        return refusal('SKILL_COMMAND_UNDECLARED', 'skill invokes an undeclared cockpit command', source.path)
    }
    for (const target of GUARD_SURFACE_TARGETS) {
        if (!equivalences[target].every(tool => body.includes(`\`${tool}\``))) {
            return refusal('SKILL_TOOL_EQUIVALENCE_MISSING', `skill entry point omits the ${target} tool equivalence`, source.path)
        }
    }
    return { name: frontmatter.name, procedure: contract.procedure, cap: Number(entryPointLines) }
}

function expectedOutputs(skills: readonly SkillDeclaration[], sources: readonly SurfaceSourceFile[]): Record<SurfaceTarget, readonly string[]> {
    const paths = Object.fromEntries(SURFACE_TARGETS.map(target => [target, []])) as unknown as Record<SurfaceTarget, readonly string[]>
    for (const target of SURFACE_TARGETS) paths[target] = sources.flatMap(source => {
        const match = /^skills\/([^/]+)\/(.+)$/.exec(source.path)
        if (!match || !skills.some(skill => skill.name === match[1])) return []
        const output = [`${TARGET_PATH_PREFIX[target]}/${match[1]}/${match[2]}`]
        if (target === 'codexcli' && match[2] === 'SKILL.md') output.push(`${TARGET_PATH_PREFIX[target]}/${match[1]}/agents/openai.yaml`)
        return output
    })
    return paths
}

function generatedDiagnostic(kind: 'refusal' | 'unavailable', status: 2 | 3, item: SurfaceGenerationDiagnostic): SkillContractResult {
    const diagnostics = [{ severity: 'error' as const, code: item.code,
        message: item.message, ...(item.target ? { target: item.target } : {}) }]
    return kind === 'refusal' && status === 2
        ? { kind, status, diagnostics, files: [] as readonly [] }
        : { kind: 'unavailable' as const, status: 3 as const, diagnostics, files: [] as readonly [] }
}

function renderedFrontmatterBytes(file: RenderedSurfaceFile): number | undefined {
    if (!file.path.endsWith('/SKILL.md')) return 0
    const parsed = parseEntryPoint(file.bytes)
    return parsed ? Buffer.byteLength(parsed.rawFrontmatter) : undefined
}

function admitDeclarations(captured: CapturedInput): SkillDeclaration[] | SkillContractResult {
    const entrySources = captured.sources.filter(source => source.path.endsWith('/SKILL.md'))
    const declarations: SkillDeclaration[] = []
    for (const source of entrySources) {
        const admitted = declaration(source)
        if ('kind' in admitted) return admitted
        if (declarations.some(skill => skill.name === admitted.name) || source.path !== `skills/${admitted.name}/SKILL.md`) {
            return refusal('SKILL_NAME_DUPLICATE', 'skill names must be unique and match their source directory', source.path)
        }
        const procedurePath = `skills/${admitted.name}/${admitted.procedure}`
        const procedure = captured.sources.find(candidate => candidate.path === procedurePath)
        const extension = captured.declaredExtensions.includes(admitted.name)
        // A shipped skill's procedure is exactly the packaged file its entry point names.
        const packaged = captured.procedures.find(candidate => candidate.path === `skills/${admitted.procedure}`)
        if (!procedure || (extension ? !pulledProcedure(procedure.bytes) : procedure.bytes !== packaged?.bytes)) {
            return refusal('SKILL_PROCEDURE_MISSING', 'skill procedure is missing or empty', procedurePath)
        }
        declarations.push(admitted)
    }
    if (!sameStrings(declarations.map(skill => skill.name).sort(), [...captured.authority.skills, ...captured.declaredExtensions].sort())) {
        return refusal('SKILL_INPUT_INVALID', 'skill set does not match the declared collection inventory')
    }
    const permittedPaths = new Set(declarations.flatMap(skill => [
        `skills/${skill.name}/SKILL.md`, `skills/${skill.name}/${skill.procedure}`,
    ]))
    if (captured.sources.length !== permittedPaths.size || captured.sources.some(source => !permittedPaths.has(source.path))) {
        return refusal('SKILL_INPUT_INVALID', 'skill sources do not exactly match the declared entry points and procedures')
    }
    return declarations
}

function inspectRendered(
    captured: CapturedInput,
    declarations: readonly SkillDeclaration[],
    files: readonly RenderedSurfaceFile[],
    targets: readonly SurfaceTarget[],
): SkillContractResult {
    const expected = expectedOutputs(declarations, captured.sources)
    if (files.some(file => !targets.includes(file.target) && file.path.startsWith(`${TARGET_PATH_PREFIX[file.target]}/`))) {
        return refusal('SKILL_RENDER_INVENTORY_INVALID', 'rendered skills include a tool that is not listed')
    }
    for (const target of targets) {
        const prefix = `${TARGET_PATH_PREFIX[target]}/`
        const actual = files.filter(file => file.target === target && file.path.startsWith(prefix)).map(file => file.path).sort()
        if (actual.length !== expected[target].length || actual.some((path, index) => path !== [...expected[target]].sort()[index])) {
            return refusal('SKILL_RENDER_INVENTORY_INVALID', 'rendered skill inventory does not exactly match the admitted neutral sources', target)
        }
    }
    const costs: SkillStandingCost[] = []
    for (const target of targets) {
        let value = 0
        for (const file of files.filter(candidate => candidate.target === target && candidate.path.startsWith(`${TARGET_PATH_PREFIX[target]}/`))) {
            const bytes = renderedFrontmatterBytes(file)
            if (bytes === undefined) return refusal('SKILL_RENDER_INVALID', 'rendered skill frontmatter is malformed', `${target}:${file.path}`)
            value += bytes
        }
        const cap = captured.authority.caps[target]
        const status = value > cap ? 'exceeded' as const : 'within_cap' as const
        costs.push({ target, metric: 'frontmatter_bytes' as const, value, cap, status })
        if (status === 'exceeded') return refusal('SKILL_STANDING_COST_EXCEEDED', `rendered ${target} installed skill set exceeds its standing-cost cap`, target)
    }
    const collection: AdmittedSkillCollection = {
        source: { path: captured.collection.path, sha256: captured.collection.sha256 },
        skills: [...captured.authority.skills], metric: captured.authority.metric,
        caps: { ...captured.authority.caps },
        procedures: captured.procedures.map(procedure => ({ path: procedure.path, sha256: procedure.sha256,
            loading: 'pull' as const, budget: 'uncapped' as const })),
        entrypoints: declarations.map(skill => ({ path: `skills/${skill.name}/SKILL.md`,
            cap: skill.cap, metric: 'lines' as const, displacement: captured.declaredExtensions.includes(skill.name)
                ? `skills/${skill.name}/${skill.procedure}` : `skills/${skill.procedure}` })),
    }
    const result = {
        kind: 'complete' as const,
        status: 0 as const,
        diagnostics: [] as readonly [],
        skills: declarations.map(skill => skill.name).sort(),
        costs,
        collection,
        files,
    }
    inspectedSkillResults.set(result, Object.freeze(Object.fromEntries(targets.map(target => [
        target, [...expected[target]].sort(),
    ]))) as Readonly<Partial<Record<SurfaceTarget, readonly string[]>>>)
    return result
}

export function extendInspectedSkillStandingCosts(
    result: SkillContractResult,
    additionalFiles: readonly RenderedSurfaceFile[],
): SkillStandingExtensionResult {
    if (result.kind !== 'complete' || !inspectedSkillResults.has(result)) {
        return refusal('SKILL_PROJECTION_INVALID', 'skill standing-cost extension requires the exact issued inspection result')
    }
    const captured = snapshotJson(additionalFiles)
    if (!Array.isArray(captured) || (captured.length > 0
        && !bundleSurfaceFiles(captured as unknown as readonly RenderedSurfaceFile[]))) {
        return refusal('SKILL_RENDER_INVALID', 'additional rendered skill files are malformed or unbounded')
    }
    const files = captured as unknown as readonly RenderedSurfaceFile[]
    const additions = new Map<SurfaceTarget, number>(SURFACE_TARGETS.map(target => [target, 0]))
    const additionalSkills = new Set<string>()
    const targetSkills = new Set<string>()
    for (const file of files) {
        const prefix = `${TARGET_PATH_PREFIX[file.target]}/`
        const match = file.path.startsWith(prefix) ? /^([^/]+)\/SKILL\.md$/.exec(file.path.slice(prefix.length)) : null
        const parsed = parseEntryPoint(file.bytes)
        const name = parsed?.frontmatter.name
        if (!match || !parsed || parsed.body.length === 0 || typeof name !== 'string' || !NAME.test(name) || name !== match[1]) {
            return refusal('SKILL_RENDER_INVALID', 'additional rendered skill frontmatter or path is invalid', `${file.target}:${file.path}`)
        }
        if (result.skills.includes(name)) {
            return refusal('SKILL_NAME_DUPLICATE', 'additional rendered skill duplicates the admitted collection inventory', `${file.target}:${file.path}`)
        }
        const targetSkill = `${file.target}\0${name}`
        if (targetSkills.has(targetSkill)) {
            return refusal('SKILL_NAME_DUPLICATE', 'additional rendered skill names must be unique per target', `${file.target}:${file.path}`)
        }
        targetSkills.add(targetSkill)
        additionalSkills.add(name)
        additions.set(file.target, additions.get(file.target)! + Buffer.byteLength(parsed.rawFrontmatter))
    }
    const costs = result.costs.map(cost => {
        const value = cost.value + additions.get(cost.target)!
        return { ...cost, value, status: value > cost.cap ? 'exceeded' as const : 'within_cap' as const }
    })
    const exceeded = costs.find(cost => cost.status === 'exceeded')
    if (exceeded) return refusal('SKILL_STANDING_COST_EXCEEDED', `rendered ${exceeded.target} installed skill set exceeds its standing-cost cap`, exceeded.target)
    const inventory = [...result.files, ...files].filter(file => file.path.endsWith('/SKILL.md'))
        .map(({ target, path, sha256 }) => ({ target, path, sha256 }))
        .sort((left, right) => {
            const leftKey = `${left.target}\0${left.path}`
            const rightKey = `${right.target}\0${right.path}`
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
        })
    return {
        kind: 'complete', status: 0, diagnostics: [] as readonly [],
        skills: [...result.skills, ...additionalSkills].sort(),
        costs,
        inventorySha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
    }
}

export function projectInspectedSkillOutputs(
    result: SkillContractResult,
    target: SurfaceTarget,
    skill: typeof SHIPPED_SETUP_SKILL,
): InspectedSkillOutputProjection {
    const expected = typeof result === 'object' && result !== null ? inspectedSkillResults.get(result) : undefined
    const targetPaths = expected?.[target]
    if (!expected || !targetPaths || result.kind !== 'complete' || !SURFACE_TARGETS.includes(target) || skill !== SHIPPED_SETUP_SKILL) {
        return refusal('SKILL_PROJECTION_INVALID', 'skill output projection requires the exact issued inspection result and target')
    }
    const prefix = `${TARGET_PATH_PREFIX[target]}/${skill}/`
    const paths = targetPaths.filter(path => path.startsWith(prefix)).sort()
    const files = result.files.filter(file => file.target === target && paths.includes(file.path))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    if (files.length !== paths.length || files.some((file, index) => file.path !== paths[index]
        || createHash('sha256').update(file.bytes).digest('hex') !== file.sha256)) {
        return refusal('SKILL_PROJECTION_INVALID', 'inspected skill output set is incomplete or changed', target)
    }
    // These bytes land in the consumer's checkout, and the first sync adopts them as already owned, so
    // they must be exactly what the full render publishes there: without its development markers.
    const published = files.map(file => {
        const bytes = stripDevelopmentMarkers(file.bytes)
        return bytes === file.bytes ? file : { ...file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    })
    const projection = { kind: 'complete' as const, target, skill, files: published }
    inspectedBootstrapOutputs.add(projection)
    return projection
}

export async function inspectSkillSet(input: unknown): Promise<SkillContractResult> {
    const captured = captureInput(input)
    if (!captured) return refusal('SKILL_INPUT_INVALID', 'skill contract input is invalid')
    const declarations = admitDeclarations(captured)
    if (!Array.isArray(declarations)) return declarations
    const generated = await generateSurfaceBatch({
        targets: SURFACE_TARGETS,
        features: ['skills'],
        sources: captured.sources,
        expectedOutputs: expectedOutputs(declarations, captured.sources),
    })
    if (generated.kind !== 'complete') return generatedDiagnostic(generated.kind, generated.status, generated.diagnostics[0]!)
    return inspectRendered(captured, declarations, generated.files, SURFACE_TARGETS)
}

export async function inspectRenderedSkillSet(input: unknown): Promise<SkillContractResult> {
    const captured = captureRenderedInput(input)
    if (!captured) return refusal('SKILL_INPUT_INVALID', 'rendered skill contract input is invalid')
    const declarations = admitDeclarations(captured)
    return Array.isArray(declarations) ? inspectRendered(captured, declarations, captured.generated.files, captured.targets) : declarations
}
