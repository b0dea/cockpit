import { createHash } from 'node:crypto'
import { parseDocument, visit } from 'yaml'

import { commands } from '../command-table.js'
import { snapshotJson, type JsonSnapshot, type JsonSnapshotObject } from '../environment/contract.js'
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

export const mechanism = {
    id: 'skill-contract',
    module: 'packages/cockpit/src/surfaces/skill-contract.ts',
    exports: ['inspectSkillSet', 'inspectRenderedSkillSet', 'isAdmittedSkillCollection',
        'projectInspectedSkillOutputs', 'isInspectedBootstrapOutputs'],
} as const

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
    readonly displacement: string
    readonly terminal: Readonly<{ path: string; sha256: string; loading: 'pull'; budget: 'uncapped' }>
    readonly entrypoints: readonly Readonly<{ path: string; cap: number; metric: 'lines'; displacement: string }>[]
}

const admittedCollections = new WeakSet<object>()

export function isAdmittedSkillCollection(value: unknown): value is AdmittedSkillCollection {
    return typeof value === 'object' && value !== null && admittedCollections.has(value)
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

export type InspectedBootstrapOutputs = Readonly<{
    kind: 'complete'
    target: SurfaceTarget
    skill: 'bootstrap'
    files: readonly RenderedSurfaceFile[]
}>

export type InspectedSkillOutputProjection = InspectedBootstrapOutputs | Readonly<{
    kind: 'refusal'
    status: 2
    diagnostics: readonly SkillContractDiagnostic[]
    files: readonly []
}>

const inspectedSkillResults = new WeakMap<object, Readonly<Record<SurfaceTarget, readonly string[]>>>()
const inspectedBootstrapOutputs = new WeakSet<object>()

export function isInspectedBootstrapOutputs(value: unknown): value is InspectedBootstrapOutputs {
    return typeof value === 'object' && value !== null && inspectedBootstrapOutputs.has(value)
}

interface CapturedInput {
    readonly sources: readonly SurfaceSourceFile[]
    readonly declaredExtensions: readonly string[]
    readonly collection: Readonly<{ path: string; bytes: string; sha256: string }>
    readonly terminal: Readonly<{ path: string; bytes: string; sha256: string }>
    readonly authority: Readonly<{ skills: readonly string[]; metric: 'frontmatter_bytes'; caps: Readonly<Record<SurfaceTarget, number>>; displacement: string }>
}

interface CapturedRenderedInput extends CapturedInput {
    readonly generated: Extract<SurfaceGenerationOutcome, { kind: 'complete' }>
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
const COMMAND = /`cockpit\s+([a-z][a-z-]*)\b/g
const INLINE_NUMBERED_STEP = /^\s*\d+[.)]\s+/m
const INLINE_FENCE = /^\s*```/m
const COPIED_DECISION_LOGIC = /(?:\bparse\w*\s+(?:the\s+)?(?:registry|cockpit\.toml)|\bTOML\.parse\b|^\s*\[[a-z][a-z0-9_.-]*\]\s*$|\|\s*(?:tier|mount|data mode|verdict)\s*\|)/im
const MISLEADING_COMPLETION = /\b(?:report|declare|claim)\w*\s+(?:the\s+)?(?:work\s+)?(?:complete|successful|green)\s+without\b/i
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(commands.map(command => command.name))
const TARGET_PATH_PREFIX: Readonly<Record<SurfaceTarget, string>> = Object.freeze({
    claudecode: '.claude/skills',
    codexcli: '.agents/skills',
    opencode: '.opencode/skills',
})

function exact(value: JsonSnapshotObject, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const wanted = [...expected].sort()
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function object(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value: JsonSnapshot | undefined): readonly string[] | undefined {
    return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0)
        && new Set(value).size === value.length ? value as readonly string[] : undefined
}

function refusal(code: string, message: string, target?: string): Extract<SkillContractResult, { kind: 'refusal' }> {
    return Object.freeze({
        kind: 'refusal' as const,
        status: 2 as const,
        diagnostics: Object.freeze([Object.freeze({ severity: 'error' as const, code, message, ...(target ? { target } : {}) })]),
        files: Object.freeze([]) as readonly [],
    })
}

function authenticatedAsset(value: JsonSnapshot | undefined, path: string): value is JsonSnapshotObject & { path: string; bytes: string; sha256: string } {
    return object(value) && exact(value, ['path', 'bytes', 'sha256']) && value.path === path
        && typeof value.bytes === 'string' && Buffer.byteLength(value.bytes) <= 65_536
        && typeof value.sha256 === 'string' && createHash('sha256').update(value.bytes).digest('hex') === value.sha256
}

function captureInput(input: unknown): CapturedInput | undefined {
    const captured = snapshotJson(input)
    if (!object(captured) || !exact(captured, ['sources', 'collection', 'terminal',
        ...(Object.hasOwn(captured, 'declaredExtensions') ? ['declaredExtensions'] : [])]) || !Array.isArray(captured.sources)
        || !authenticatedAsset(captured.collection, 'skills/collection.json')
        || !authenticatedAsset(captured.terminal, 'skills/procedures/onboarding.md')) return undefined
    let authority: JsonSnapshot | undefined
    try {
        authority = snapshotJson(JSON.parse(captured.collection.bytes))
        const json = parseDocument(captured.collection.bytes, { uniqueKeys: true })
        if (json.errors.length > 0 || json.warnings.length > 0) return undefined
    } catch { return undefined }
    if (!object(authority) || !exact(authority, ['skills', 'metric', 'caps', 'displacement'])
        || !Array.isArray(authority.skills) || !sameStrings(authority.skills, ['bootstrap', 'explain', 'fix']) || authority.metric !== 'frontmatter_bytes'
        || authority.displacement !== captured.terminal.path || !object(authority.caps) || !exact(authority.caps, SURFACE_TARGETS)) return undefined
    const caps = authority.caps
    const shippedSkills = authority.skills
    if (SURFACE_TARGETS.some(target => !Number.isSafeInteger(caps[target]) || Number(caps[target]) < 1
        || Number(caps[target]) > INSTALLED_SET_CAP_MAX_BYTES)) return undefined
    const declaredExtensions = Object.hasOwn(captured, 'declaredExtensions') ? captured.declaredExtensions : []
    if (!Array.isArray(declaredExtensions) || declaredExtensions.length > SURFACE_OUTPUT_MAX_FILES
        || declaredExtensions.some((name, index) => typeof name !== 'string' || name.length > 128 || !NAME.test(name)
            || shippedSkills.includes(name) || index > 0 && String(declaredExtensions[index - 1]) >= name)) return undefined
    if (!surfaceSourcesMatchFeature(captured.sources, 'skills')) return undefined
    const terminal = parseEntryPoint(captured.terminal.bytes)
    if (!terminal || !exact(terminal.frontmatter, ['loading', 'budget']) || terminal.frontmatter.loading !== 'pull'
        || terminal.frontmatter.budget !== 'uncapped' || terminal.body.length === 0) return undefined
    return Object.freeze({ ...captured, declaredExtensions, authority }) as unknown as CapturedInput
}

function captureRenderedInput(input: unknown): CapturedRenderedInput | undefined {
    const captured = snapshotJson(input)
    if (!object(captured) || !exact(captured, ['sources', 'collection', 'terminal', 'generated',
        ...(Object.hasOwn(captured, 'declaredExtensions') ? ['declaredExtensions'] : [])])) return undefined
    const base = captureInput({ sources: captured.sources, collection: captured.collection, terminal: captured.terminal,
        ...(Object.hasOwn(captured, 'declaredExtensions') ? { declaredExtensions: captured.declaredExtensions } : {}) })
    const generated = captured.generated
    if (!base || !object(generated) || !exact(generated, ['kind', 'status', 'diagnostics', 'mechanism', 'files', 'warnings'])
        || generated.kind !== 'complete' || generated.status !== 0 || !Array.isArray(generated.diagnostics) || generated.diagnostics.length !== 0
        || !object(generated.mechanism) || !exact(generated.mechanism, ['package', 'version', 'role'])
        || generated.mechanism.package !== 'rulesync' || generated.mechanism.version !== '40.2.0' || generated.mechanism.role !== 'spelling'
        || !Array.isArray(generated.files) || !Array.isArray(generated.warnings)
        || !generated.warnings.every((warning): warning is SurfaceGenerationWarning => object(warning)
            && exact(warning, ['severity', 'code', 'target', 'path', 'message']) && warning.severity === 'warning'
            && warning.code === 'SURFACE_GENERATOR_TRUST_WARNING' && SURFACE_TARGETS.includes(warning.target as SurfaceTarget)
            && warning.path === '.claude/settings.json' && typeof warning.message === 'string' && warning.message.length > 0)
        || !bundleSurfaceFiles(generated.files as unknown as readonly RenderedSurfaceFile[])) return undefined
    return Object.freeze({ ...base, generated }) as unknown as CapturedRenderedInput
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

function targetEquivalences(value: JsonSnapshot | undefined): Readonly<Record<SurfaceTarget, readonly string[]>> | undefined {
    if (!object(value) || !exact(value, SURFACE_TARGETS)) return undefined
    const claudecode = strings(value.claudecode)
    const codexcli = strings(value.codexcli)
    const opencode = strings(value.opencode)
    if (!claudecode || !codexcli || !opencode) return undefined
    return Object.freeze({ claudecode, codexcli, opencode })
}

function sameStrings(value: JsonSnapshot | undefined, expected: readonly string[]): boolean {
    return Array.isArray(value) && value.length === expected.length
        && value.every((item, index) => item === expected[index])
}

function targetToolsMatch(frontmatter: JsonSnapshotObject, equivalences: Readonly<Record<SurfaceTarget, readonly string[]>>): boolean {
    const claude = frontmatter.claudecode
    const opencode = frontmatter.opencode
    const codex = frontmatter.codexcli
    if (!object(claude) || !exact(claude, ['allowed-tools']) || !sameStrings(claude['allowed-tools'], equivalences.claudecode)
        || !object(opencode) || !exact(opencode, ['allowed-tools']) || !sameStrings(opencode['allowed-tools'], equivalences.opencode)
        || !object(codex) || !exact(codex, ['dependencies'])) return false
    const dependencies = codex.dependencies
    if (!object(dependencies) || !exact(dependencies, ['tools']) || !Array.isArray(dependencies.tools)
        || dependencies.tools.length !== 1 || !object(dependencies.tools[0])) return false
    const executable = dependencies.tools[0]
    return exact(executable, ['type', 'value', 'description']) && executable.type === 'executable'
        && executable.value === 'cockpit' && typeof executable.description === 'string' && executable.description.length > 0
}

function declaration(source: SurfaceSourceFile): SkillDeclaration | SkillContractResult {
    const parsed = parseEntryPoint(source.bytes)
    if (!parsed) return refusal('SKILL_FRONTMATTER_INVALID', 'skill frontmatter is missing, malformed, aliased, duplicated, or unbounded', source.path)
    const { frontmatter, body } = parsed
    if (!exact(frontmatter, ['name', 'description', 'targets', 'cockpit', 'claudecode', 'codexcli', 'opencode'])) {
        return refusal('SKILL_FRONTMATTER_INVALID', 'skill frontmatter contains an unexpected or missing field', source.path)
    }
    const contract = frontmatter.cockpit
    if (!object(contract) || !exact(contract, [
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
        || !object(review) || !exact(review, ['mechanical', 'judgment'])
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
    const invoked = [...body.matchAll(COMMAND)].map(match => match[1]!)
    if (invoked.some(command => !declaredCommands.includes(command) || !ALLOWED_COMMANDS.has(command))) {
        return refusal('SKILL_COMMAND_UNDECLARED', 'skill invokes an undeclared cockpit command', source.path)
    }
    for (const target of SURFACE_TARGETS) {
        if (!equivalences[target].every(tool => body.includes(`\`${tool}\``))) {
            return refusal('SKILL_TOOL_EQUIVALENCE_MISSING', `skill entry point omits the ${target} tool equivalence`, source.path)
        }
    }
    return Object.freeze({ name: frontmatter.name, procedure: contract.procedure, cap: Number(entryPointLines) })
}

function expectedOutputs(skills: readonly SkillDeclaration[], sources: readonly SurfaceSourceFile[]): Record<SurfaceTarget, readonly string[]> {
    const paths: Record<SurfaceTarget, readonly string[]> = { claudecode: [], codexcli: [], opencode: [] }
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
    const diagnostics = Object.freeze([Object.freeze({ severity: 'error' as const, code: item.code,
        message: item.message, ...(item.target ? { target: item.target } : {}) })])
    return kind === 'refusal' && status === 2
        ? Object.freeze({ kind, status, diagnostics, files: Object.freeze([]) as readonly [] })
        : Object.freeze({ kind: 'unavailable' as const, status: 3 as const, diagnostics, files: Object.freeze([]) as readonly [] })
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
        if (!captured.sources.some(candidate => candidate.path === procedurePath && candidate.bytes === captured.terminal.bytes)
            || `skills/${admitted.procedure}` !== captured.authority.displacement) {
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
): SkillContractResult {
    const expected = expectedOutputs(declarations, captured.sources)
    for (const target of SURFACE_TARGETS) {
        const prefix = `${TARGET_PATH_PREFIX[target]}/`
        const actual = files.filter(file => file.target === target && file.path.startsWith(prefix)).map(file => file.path).sort()
        if (actual.length !== expected[target].length || actual.some((path, index) => path !== [...expected[target]].sort()[index])) {
            return refusal('SKILL_RENDER_INVENTORY_INVALID', 'rendered skill inventory does not exactly match the admitted neutral sources', target)
        }
    }
    const costs: SkillStandingCost[] = []
    for (const target of SURFACE_TARGETS) {
        let value = 0
        for (const file of files.filter(candidate => candidate.target === target && candidate.path.startsWith(`${TARGET_PATH_PREFIX[target]}/`))) {
            const bytes = renderedFrontmatterBytes(file)
            if (bytes === undefined) return refusal('SKILL_RENDER_INVALID', 'rendered skill frontmatter is malformed', `${target}:${file.path}`)
            value += bytes
        }
        const cap = captured.authority.caps[target]
        const status = value > cap ? 'exceeded' as const : 'within_cap' as const
        costs.push(Object.freeze({ target, metric: 'frontmatter_bytes' as const, value, cap, status }))
        if (status === 'exceeded') return refusal('SKILL_STANDING_COST_EXCEEDED', `rendered ${target} installed skill set exceeds its standing-cost cap`, target)
    }
    const collection: AdmittedSkillCollection = Object.freeze({
        source: Object.freeze({ path: captured.collection.path, sha256: captured.collection.sha256 }),
        skills: Object.freeze([...captured.authority.skills]), metric: captured.authority.metric,
        caps: Object.freeze({ ...captured.authority.caps }), displacement: captured.authority.displacement,
        terminal: Object.freeze({ path: captured.terminal.path, sha256: captured.terminal.sha256, loading: 'pull', budget: 'uncapped' }),
        entrypoints: Object.freeze(declarations.map(skill => Object.freeze({ path: `skills/${skill.name}/SKILL.md`,
            cap: skill.cap, metric: 'lines' as const, displacement: captured.authority.displacement }))),
    })
    admittedCollections.add(collection)
    const result = Object.freeze({
        kind: 'complete' as const,
        status: 0 as const,
        diagnostics: Object.freeze([]) as readonly [],
        skills: Object.freeze(declarations.map(skill => skill.name).sort()),
        costs: Object.freeze(costs),
        collection,
        files,
    })
    inspectedSkillResults.set(result, Object.freeze({
        claudecode: Object.freeze([...expected.claudecode].sort()),
        codexcli: Object.freeze([...expected.codexcli].sort()),
        opencode: Object.freeze([...expected.opencode].sort()),
    }))
    return result
}

export function projectInspectedSkillOutputs(
    result: SkillContractResult,
    target: SurfaceTarget,
    skill: 'bootstrap',
): InspectedSkillOutputProjection {
    const expected = typeof result === 'object' && result !== null ? inspectedSkillResults.get(result) : undefined
    if (!expected || result.kind !== 'complete' || !SURFACE_TARGETS.includes(target) || skill !== 'bootstrap') {
        return refusal('SKILL_PROJECTION_INVALID', 'skill output projection requires the exact issued inspection result and target')
    }
    const prefix = `${TARGET_PATH_PREFIX[target]}/${skill}/`
    const paths = expected[target].filter(path => path.startsWith(prefix)).sort()
    const files = result.files.filter(file => file.target === target && paths.includes(file.path))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    if (files.length !== paths.length || files.some((file, index) => file.path !== paths[index]
        || createHash('sha256').update(file.bytes).digest('hex') !== file.sha256)) {
        return refusal('SKILL_PROJECTION_INVALID', 'inspected skill output set is incomplete or changed', target)
    }
    const projection = Object.freeze({ kind: 'complete' as const, target, skill, files: Object.freeze([...files]) })
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
    return inspectRendered(captured, declarations, generated.files)
}

export async function inspectRenderedSkillSet(input: unknown): Promise<SkillContractResult> {
    const captured = captureRenderedInput(input)
    if (!captured) return refusal('SKILL_INPUT_INVALID', 'rendered skill contract input is invalid')
    const declarations = admitDeclarations(captured)
    return Array.isArray(declarations) ? inspectRendered(captured, declarations, captured.generated.files) : declarations
}
