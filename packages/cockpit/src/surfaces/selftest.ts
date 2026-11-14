import { isDeepStrictEqual } from 'node:util'

import { sha256Hex } from '../sha256.js'
import { nativeInputInvocation } from '../../libexec/native-selftest-input.mjs'
import { nativeGuardInvocation, validNativeGuardHookCommand } from '../../libexec/native-selftest-guard.mjs'

import type { GeneratedSurfaceSelftestProjection } from '../environment/generated-application/shared.js'
import { snapshotGeneratedJson } from '../environment/contract.js'
import { SURFACE_TARGETS, type SurfaceTarget } from './harness-registry.js'
import { classifySurfaceOwnership, type SurfaceDesiredEntry } from './ownership.js'

export type SelftestCapability = 'instruction-loading' | 'guard-firing' | 'skill-parity'

export type SelftestHarnessRef =
    | Readonly<{ kind: 'builtin'; target: 'claudecode'; name: 'Claude Code' }>
    | Readonly<{ kind: 'builtin'; target: 'codexcli'; name: 'Codex' }>
    | Readonly<{ kind: 'builtin'; target: 'opencode'; name: 'OpenCode' }>

export type SelftestCellKey =
    | Readonly<{ harness: SelftestHarnessRef; capability: 'instruction-loading' | 'guard-firing' }>
    | Readonly<{ harness: SelftestHarnessRef; capability: 'skill-parity'; skill: string }>

export interface SelftestExpectation {
    readonly schema: 'cockpit-harness-selftest-expectation/v1'
    readonly generatedManifestSha256: string
    readonly instructionSourceSha256?: string
    readonly nativeSourceSha256?: Readonly<Record<string, string>>
    readonly guardProbeHost?: string
    readonly guardHookCommand?: string
    readonly cells: readonly SelftestCellKey[]
    readonly shippedSkills: readonly string[]
    readonly reviewHarnesses: readonly [
        Readonly<{ name: 'Claude Code'; nativeDiagnostics: false }>,
        Readonly<{ name: 'Codex'; nativeDiagnostics: true }>,
    ]
}

export interface SelftestProbeSpecification {
    readonly protocol?: 'codex-prompt-input/v1' | 'claude-model-input/v1' | 'codex-skill-input/v1' | 'claude-guard-loopback/v1' | 'native-unsupported/v1'
    readonly guardHost?: string
    readonly harness: SelftestHarnessRef
    readonly capability: SelftestCapability
    readonly invocation: readonly [string, ...string[]]
    readonly versionCommand: readonly [string, ...string[]]
    readonly helpCommand: readonly [string, ...string[]]
    readonly candidateCode: string
    readonly brokenCode: string
    readonly unavailableCode: string
    readonly sample: Readonly<{ skill: string; features: readonly ('name' | 'trigger' | 'body-load' | 'tools' | 'non-goals')[] }> | null
}

export interface PlannedSelftestProbe extends SelftestProbeSpecification {
    readonly cell: SelftestCellKey
    readonly entries: readonly SurfaceDesiredEntry[]
    /** For Claude Code instruction loading: the team's CLAUDE.md cockpit left in place, as sync read it. */
    readonly teamClaudeGuide?: string
    /** For instruction loading: the whole root AGENTS.md as sync leaves it, which is what the tool loads. */
    readonly instructionFile?: string
}

export type SurfaceSelftestPlanResult =
    | Readonly<{
        kind: 'complete'
        expectation: SelftestExpectation
        probes: readonly PlannedSelftestProbe[]
    }>
    | Readonly<{ kind: 'refusal'; code: 'SELFTEST_SOURCE_INVALID'; reason: string }>

export type SelftestHumanNeededRecord = Readonly<{
    kind: 'human_needed'
    harness: SelftestHarnessRef
    capability: 'instruction-loading' | 'guard-firing'
    generatedManifestSha256: string
    observedAt: string
    reason: 'executable_missing' | 'authentication_required' | 'isolation_unavailable' | 'native_protocol_unsupported' | 'guard_host_undeclared' | 'probe_failed'
    operatorAction: string
}> | Readonly<{
    kind: 'human_needed'
    harness: SelftestHarnessRef
    capability: 'skill-parity'
    skill: string
    generatedManifestSha256: string
    observedAt: string
    reason: 'executable_missing' | 'authentication_required' | 'isolation_unavailable' | 'native_protocol_unsupported' | 'guard_host_undeclared' | 'probe_failed'
    operatorAction: string
}>

export interface SelftestSkillReviewRecord {
    readonly skill: string
    readonly harness: 'Claude Code' | 'Codex'
    readonly status: 'evidenced' | 'human_needed'
    readonly reviewedOn: string | null
    readonly evidenceRunId: string | null
    readonly reviewers: readonly ('official-authoring' | 'harness-diagnostics')[]
    readonly checks: Readonly<{
        trigger: 'pass'
        silence: 'pass'
        bodyLoad: 'pass'
        tools: 'pass'
        nonGoals: 'pass'
    }> | null
    readonly operatorAction: string | null
}

const SHA256 = /^[a-f0-9]{64}$/
const CODE = /^[A-Z][A-Z0-9_]{2,127}$/
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/
const SAMPLE_FEATURES = new Set(['name', 'trigger', 'body-load', 'tools', 'non-goals'])
const CAPABILITIES = Object.freeze<SelftestCapability[]>(['instruction-loading', 'guard-firing', 'skill-parity'])
const BUILTINS = Object.freeze<Record<string, SelftestHarnessRef>>({
    claudecode: Object.freeze({ kind: 'builtin', target: 'claudecode', name: 'Claude Code' }),
    codexcli: Object.freeze({ kind: 'builtin', target: 'codexcli', name: 'Codex' }),
    opencode: Object.freeze({ kind: 'builtin', target: 'opencode', name: 'OpenCode' }),
})
function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function cellKey(cell: SelftestCellKey): string {
    return `${cell.harness.kind}\0${cell.harness.target}\0${cell.capability}\0${cell.capability === 'skill-parity' ? cell.skill : ''}`
}

function shippedSkills(entries: readonly SurfaceDesiredEntry[]): readonly string[] | undefined {
    const names = new Set<string>()
    for (const entry of entries) {
        const match = /^(?:\.claude|\.opencode|\.agents)\/skills\/([^/]+)\/(?:SKILL\.md|skill\.md)$/.exec(entry.path)
        if (!match) continue
        if (!SKILL_NAME.test(match[1]!)) return undefined
        names.add(match[1]!)
    }
    return [...names].sort(compareCodeUnits)
}

export function surfaceSelftestExpectation(projection: GeneratedSurfaceSelftestProjection): SelftestExpectation | undefined {
    try {
    const captured = snapshotGeneratedJson(projection) as unknown as GeneratedSurfaceSelftestProjection | undefined
    if (!captured || captured.schema !== 'cockpit-generated-surface-selftest/v1' || !SHA256.test(captured.manifestSha256)) return undefined
    if (captured.guardProbeHost !== undefined && (typeof captured.guardProbeHost !== 'string' || captured.guardProbeHost.length > 253
        || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(captured.guardProbeHost))) return undefined
    if (captured.guardHookCommand !== undefined && !validNativeGuardHookCommand(captured.guardHookCommand)) return undefined
    if (captured.cockpitHookCommands !== undefined && (!Array.isArray(captured.cockpitHookCommands) || captured.cockpitHookCommands.length === 0
        || captured.cockpitHookCommands.length > 64 || !captured.cockpitHookCommands.every(validNativeGuardHookCommand))) return undefined
    if (captured.teamClaudeGuide !== undefined && (typeof captured.teamClaudeGuide !== 'string'
        || captured.entries.some(entry => entry.path === 'CLAUDE.md'))) return undefined
    const rootGuide = captured.entries.find(entry => entry.path === 'AGENTS.md')
    // The measured file must hold cockpit's region exactly once, or the probe would measure other text.
    if (captured.rootGuideFile !== undefined && (typeof captured.rootGuideFile !== 'string' || rootGuide?.kind !== 'shared-region'
        || rootGuide.region.format !== 'markdown-delimited' || captured.rootGuideFile.split(rootGuide.region.bytes).length !== 2)) return undefined
    const payload = {
        schema: captured.schema,
        configuredHarnesses: captured.configuredHarnesses,
        entries: captured.entries,
        ...(captured.guardProbeHost === undefined ? {} : { guardProbeHost: captured.guardProbeHost }),
        ...(captured.guardHookCommand === undefined ? {} : { guardHookCommand: captured.guardHookCommand }),
        ...(captured.cockpitHookCommands === undefined ? {} : { cockpitHookCommands: captured.cockpitHookCommands }),
        ...(captured.teamClaudeGuide === undefined ? {} : { teamClaudeGuide: captured.teamClaudeGuide }),
        ...(captured.rootGuideFile === undefined ? {} : { rootGuideFile: captured.rootGuideFile }),
    }
    if (sha256Hex(JSON.stringify(payload)) !== captured.manifestSha256) return undefined
    const ownership = classifySurfaceOwnership({ configuredHarnesses: captured.configuredHarnesses, entries: captured.entries })
    if (ownership.kind !== 'complete') return undefined
    const configured = new Set(captured.configuredHarnesses)
    if (configured.size !== captured.configuredHarnesses.length
        || [...configured].some((name) => !SURFACE_TARGETS.includes(name as SurfaceTarget))) return undefined
    const skills = shippedSkills(ownership.entries)
    if (!skills || skills.length === 0 || skills.length > 256) return undefined
    const cells: SelftestCellKey[] = []
    for (const target of Object.keys(BUILTINS).sort(compareCodeUnits)) {
        if (!configured.has(target)) continue
        for (const capability of CAPABILITIES) {
            if (capability === 'skill-parity') {
                for (const skill of skills) cells.push({ harness: BUILTINS[target]!, capability, skill })
            } else cells.push({ harness: BUILTINS[target]!, capability })
        }
    }
    if (cells.length === 0 || cells.length > 256) return undefined
    const uniqueCells = new Map(cells.map((cell) => [cellKey(cell), cell]))
    if (uniqueCells.size !== cells.length) return undefined
    const instructions = captured.entries.find(entry => entry.path === 'AGENTS.md' && entry.harnesses.includes('codexcli'))
    const instructionBytes = captured.rootGuideFile ?? (instructions?.kind === 'file' ? instructions.bytes
        : instructions?.region.format === 'markdown-delimited' ? instructions.region.bytes : undefined)
    return {
        ...(instructionBytes === undefined ? {} : { instructionSourceSha256: sha256Hex(instructionBytes) }),
        nativeSourceSha256: Object.fromEntries(captured.entries.flatMap(entry => {
            if (!/^(?:AGENTS\.md|CLAUDE\.md|\.claude\/settings\.json|\.(?:agents|claude)\/skills\/[^/]+\/SKILL\.md)$/.test(entry.path)) return []
            const bytes = entry.kind === 'file' ? entry.bytes : entry.region.format === 'markdown-delimited' ? entry.region.bytes
                : `${JSON.stringify(Object.fromEntries(entry.region.members.map(member => [member.key, JSON.parse(member.valueBytes)])), null, 2)}\n`
            return bytes === undefined ? [] : [[entry.path, sha256Hex(entry.path === 'AGENTS.md' ? captured.rootGuideFile ?? bytes : bytes)]]
        }).concat(captured.teamClaudeGuide === undefined ? [] : [['CLAUDE.md', sha256Hex(captured.teamClaudeGuide)]])),
        ...(captured.guardProbeHost === undefined ? {} : { guardProbeHost: captured.guardProbeHost }),
        ...(captured.guardHookCommand === undefined ? {} : { guardHookCommand: captured.guardHookCommand }),
        schema: 'cockpit-harness-selftest-expectation/v1',
        generatedManifestSha256: captured.manifestSha256,
        cells: [...uniqueCells.values()].sort((left, right) => compareCodeUnits(cellKey(left), cellKey(right))),
        shippedSkills: skills,
        reviewHarnesses: [
            { name: 'Claude Code', nativeDiagnostics: false },
            { name: 'Codex', nativeDiagnostics: true },
        ] as const,
    }
    } catch { /* a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses. */ return undefined }
}

function sameHarness(left: SelftestHarnessRef, right: SelftestHarnessRef): boolean {
    return left.kind === right.kind && left.target === right.target && left.name === right.name
}

function specificationCellKey(value: unknown): string | undefined {
    if (value === null || typeof value !== 'object') return undefined
    const row = value as Partial<SelftestProbeSpecification>
    if (row.harness === null || typeof row.harness !== 'object' || typeof row.capability !== 'string') return undefined
    try {
        if (row.capability === 'skill-parity') {
            const sample = row.sample as SelftestProbeSpecification['sample']
            if (!sample || typeof sample.skill !== 'string') return undefined
            return cellKey({ harness: row.harness as SelftestHarnessRef, capability: 'skill-parity', skill: sample.skill })
        }
        if (row.capability !== 'instruction-loading' && row.capability !== 'guard-firing') return undefined
        return cellKey({ harness: row.harness as SelftestHarnessRef, capability: row.capability })
    } catch { /* a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses. */ return undefined }
}

function validProbe(probe: SelftestProbeSpecification, cell: SelftestCellKey, guardHost?: string): boolean {
    try {
    if (Object.keys(probe).sort().join('\0') !== [
        'brokenCode', 'candidateCode', 'capability', 'harness', 'helpCommand', 'invocation',
        'sample', 'unavailableCode', 'versionCommand', ...(probe.protocol === undefined ? [] : ['protocol']), ...(probe.guardHost === undefined ? [] : ['guardHost']),
    ].sort().join('\0')) return false
    if (probe.harness.kind !== 'builtin' || Object.keys(probe.harness).sort().join('\0') !== 'kind\0name\0target') return false
    if (probe.protocol !== undefined) return isDeepStrictEqual(probe, snapshotGeneratedJson(nativeSpecification(cell, guardHost)))
    const commands = [probe.invocation, probe.versionCommand, probe.helpCommand]
    const sample = probe.sample
    const validSample = sample !== null && Object.keys(sample).sort().join('\0') === 'features\0skill'
        && SKILL_NAME.test(sample.skill) && sample.features.length > 0 && sample.features.length <= SAMPLE_FEATURES.size
        && new Set(sample.features).size === sample.features.length && sample.features.every((feature) => SAMPLE_FEATURES.has(feature))
    return sameHarness(probe.harness, cell.harness) && probe.capability === cell.capability
        && commands.every((command) => Array.isArray(command) && command.length > 0 && command.length <= 128
            && command.every((value) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 65_536 && !value.includes('\0')))
        && probe.invocation.filter((value) => value === '{control}').length === 1
        && [probe.candidateCode, probe.brokenCode, probe.unavailableCode].every((code) => CODE.test(code))
        && probe.unavailableCode === `${probe.capability.replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`
        && commands.every((command) => command[0] === '{executable}')
        && (cell.capability === 'skill-parity'
            ? validSample && probe.sample!.skill === cell.skill
            : probe.sample === null)
    } catch { /* a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses. */ return false }
}

/** `<harness> <capability>[ <skill>]`, the name a person sees for a cell. */
export function surfaceSelftestCellLabel(cell: SelftestCellKey): string {
    return `${cell.harness.name} ${cell.capability}${cell.capability === 'skill-parity' ? ` ${cell.skill}` : ''}`
}

function nativeSpecification(cell: SelftestCellKey, guardHost?: string): SelftestProbeSpecification {
    const supported = cell.harness.target === 'codexcli' && cell.capability === 'instruction-loading'
    const modelInput = cell.harness.target !== 'opencode' && cell.capability !== 'guard-firing' && !supported
    const guard = cell.harness.target === 'claudecode' && cell.capability === 'guard-firing' && guardHost !== undefined
    const skill = cell.capability === 'skill-parity' ? cell.skill : undefined
    return {
        protocol: guard ? 'claude-guard-loopback/v1' : supported ? 'codex-prompt-input/v1' : modelInput
            ? cell.harness.target === 'claudecode' ? 'claude-model-input/v1' : 'codex-skill-input/v1' : 'native-unsupported/v1',
        harness: cell.harness, capability: cell.capability,
        ...(guard ? { guardHost } : {}),
        invocation: guard ? nativeGuardInvocation(guardHost) : supported ? ['{executable}', 'debug', 'prompt-input', 'Do not run tools.']
            : modelInput ? nativeInputInvocation(cell.harness.target as 'claudecode' | 'codexcli', skill) : ['{executable}', '--help'],
        versionCommand: ['{executable}', '--version'], helpCommand: ['{executable}', '--help'],
        candidateCode: guard ? 'NATIVE_GUARD_FIRED' : supported || modelInput && !skill ? 'NATIVE_INSTRUCTIONS_LOADED' : modelInput ? 'NATIVE_SKILL_BODY_LOADED' : 'NATIVE_PROTOCOL_UNSUPPORTED',
        brokenCode: guard ? 'NATIVE_GUARD_BROKEN' : supported || modelInput && !skill ? 'NATIVE_INSTRUCTIONS_REPLACED' : modelInput ? 'NATIVE_SKILL_CONTROL_REJECTED' : 'NATIVE_PROTOCOL_UNSUPPORTED',
        unavailableCode: `${cell.capability.replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`,
        sample: cell.capability === 'skill-parity' ? { skill: cell.skill, features: modelInput ? ['body-load'] : [] } : null,
    }
}

/**
 * Complete legacy rows carry forward unchanged. New cells use closed native protocols, with
 * unsupported adapters explicitly pending rather than asking people to invent diagnostic codes.
 */
export function draftSurfaceSelftestSpecifications(
    projection: GeneratedSurfaceSelftestProjection,
    previous: readonly unknown[] = [],
): Readonly<{
    specifications: readonly SelftestProbeSpecification[]
    carried: number
}> | undefined {
    const expectation = surfaceSelftestExpectation(projection)
    if (!expectation) return undefined
    const earlier = new Map<string, SelftestProbeSpecification>()
    for (const row of previous) {
        const key = specificationCellKey(row)
        const captured = key === undefined ? undefined : snapshotGeneratedJson(row) as unknown as SelftestProbeSpecification | undefined
        if (key !== undefined && captured !== undefined && !earlier.has(key)) earlier.set(key, captured)
    }
    let carried = 0
    const specifications = expectation.cells.map((cell) => {
        const kept = earlier.get(cellKey(cell))
        if (kept && validProbe(kept, cell, expectation.guardProbeHost)) {
            carried += 1
            return kept
        }
        return nativeSpecification(cell, expectation.guardProbeHost)
    })
    return { specifications, carried }
}

/** Names each row whose person-supplied fields are still null, as `<harness> <capability>[ <skill>]: <fields>`. */
export function unfilledSurfaceSelftestSpecifications(specifications: readonly unknown[]): readonly string[] {
    const rows: string[] = []
    for (const value of specifications) {
        if (value === null || typeof value !== 'object') continue
        const row = value as Readonly<Record<string, unknown>>
        const fields: string[] = ['invocation', 'candidateCode', 'brokenCode'].filter((field) => row[field] === null)
        const sample = row.sample as Readonly<Record<string, unknown>> | null | undefined
        if (sample !== null && typeof sample === 'object' && sample.features === null) fields.push('sample.features')
        if (fields.length === 0) continue
        const harness = row.harness as SelftestHarnessRef | null | undefined
        const label = harness !== null && typeof harness === 'object' ? harness.name : 'unknown harness'
        const skill = sample !== null && typeof sample === 'object' && typeof sample.skill === 'string' ? ` ${sample.skill}` : ''
        rows.push(`${label} ${String(row.capability)}${skill}: ${fields.join(', ')}`)
    }
    return rows
}

export function planSurfaceSelftest(
    projection: GeneratedSurfaceSelftestProjection,
    specifications: readonly SelftestProbeSpecification[],
): SurfaceSelftestPlanResult {
    const capturedProjection = snapshotGeneratedJson(projection) as unknown as GeneratedSurfaceSelftestProjection | undefined
    const expectation = capturedProjection ? surfaceSelftestExpectation(capturedProjection) : undefined
    if (!expectation) return { kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: 'generated selftest projection is invalid' }
    const capturedSpecifications = snapshotGeneratedJson(specifications) as unknown as readonly SelftestProbeSpecification[] | undefined
    if (!capturedSpecifications) return { kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: 'probe specifications are malformed' }
    if (capturedSpecifications.length !== expectation.cells.length || capturedSpecifications.length > 256) {
        return { kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: 'probe specifications do not exactly cover expected cells' }
    }
    const byCell = new Map<string, SelftestProbeSpecification>()
    for (const specification of capturedSpecifications) {
        const key = specificationCellKey(specification)
        if (!key) return { kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: 'probe specification is malformed' }
        if (byCell.has(key)) return { kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: 'probe specifications contain duplicate cells' }
        byCell.set(key, specification)
    }
    const probes: PlannedSelftestProbe[] = []
    for (const cell of expectation.cells) {
        const specification = byCell.get(cellKey(cell))
        if (!specification || !validProbe(specification, cell, expectation.guardProbeHost)) {
            return { kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: 'probe specification is malformed or does not match source authority' }
        }
        if (specification.sample && !expectation.shippedSkills.includes(specification.sample.skill)) {
            return { kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: 'skill parity sample is not a shipped skill' }
        }
        probes.push({
            ...specification,
            cell,
            entries: capturedProjection!.entries.filter((entry) => entry.harnesses.includes(cell.harness.target)),
            ...(capturedProjection!.teamClaudeGuide !== undefined && cell.harness.target === 'claudecode'
                && cell.capability === 'instruction-loading' ? { teamClaudeGuide: capturedProjection!.teamClaudeGuide } : {}),
            ...(capturedProjection!.rootGuideFile !== undefined && cell.capability === 'instruction-loading'
                ? { instructionFile: capturedProjection!.rootGuideFile } : {}),
        })
    }
    return { kind: 'complete', expectation, probes }
}

export function surfaceSelftestHumanNeeded(
    expectation: SelftestExpectation,
    cell: SelftestCellKey,
    reason: SelftestHumanNeededRecord['reason'],
    observedAt: string,
    operatorAction: string,
): SelftestHumanNeededRecord | undefined {
    if (!expectation.cells.some((candidate) => cellKey(candidate) === cellKey(cell))
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)
        || operatorAction.length === 0 || Buffer.byteLength(operatorAction) > 4096 || operatorAction.includes('\0')) return undefined
    if (cell.capability === 'skill-parity') return {
        kind: 'human_needed', harness: cell.harness, capability: cell.capability, skill: cell.skill,
        generatedManifestSha256: expectation.generatedManifestSha256, observedAt, reason, operatorAction,
    }
    return {
        kind: 'human_needed', harness: cell.harness, capability: cell.capability,
        generatedManifestSha256: expectation.generatedManifestSha256, observedAt, reason, operatorAction,
    }
}

export function surfaceSelftestReviews(
    expectation: SelftestExpectation,
    evidenced: readonly Readonly<{ skill: string; harness: 'Claude Code' | 'Codex'; reviewedOn: string; evidenceRunId: string }>[],
): readonly SelftestSkillReviewRecord[] | undefined {
    const rows = new Map(evidenced.map((row) => [`${row.skill}\0${row.harness}`, row]))
    if (rows.size !== evidenced.length || evidenced.some((row) => !expectation.shippedSkills.includes(row.skill)
        || !expectation.reviewHarnesses.some((harness) => harness.name === row.harness)
        || typeof row.reviewedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.reviewedOn)
        || new Date(`${row.reviewedOn}T00:00:00.000Z`).toISOString().slice(0, 10) !== row.reviewedOn
        || typeof row.evidenceRunId !== 'string' || row.evidenceRunId.length === 0
        || Buffer.byteLength(row.evidenceRunId) > 128 || row.evidenceRunId.includes('\0'))
        || new Set(evidenced.map((row) => row.evidenceRunId)).size !== evidenced.length) return undefined
    const reviews: SelftestSkillReviewRecord[] = []
    for (const skill of expectation.shippedSkills) for (const harness of expectation.reviewHarnesses) {
        const row = rows.get(`${skill}\0${harness.name}`)
        if (row) reviews.push({
            skill, harness: harness.name, status: 'evidenced', reviewedOn: row.reviewedOn,
            evidenceRunId: row.evidenceRunId,
            reviewers: harness.nativeDiagnostics
                ? ['official-authoring', 'harness-diagnostics'] as const
                : ['official-authoring'] as const,
            checks: { trigger: 'pass', silence: 'pass', bodyLoad: 'pass', tools: 'pass', nonGoals: 'pass' },
            operatorAction: null,
        })
        else reviews.push({
            skill, harness: harness.name, status: 'human_needed', reviewedOn: null, evidenceRunId: null,
            reviewers: [], checks: null,
            operatorAction: `A person judges ${skill} in ${harness.name} for its trigger, silence, body loading, tools and non-goals; cockpit cannot perform or record this review`,
        })
    }
    return reviews
}
