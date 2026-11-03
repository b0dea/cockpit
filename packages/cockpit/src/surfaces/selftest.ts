import { createHash } from 'node:crypto'

import type {
    GeneratedCustomSurfaceSelftestInput,
    GeneratedSurfaceSelftestProjection,
} from '../environment/generated-application.js'
import { snapshotGeneratedJson } from '../environment/contract.js'
import type { SurfaceFeature } from './contract.js'
import { SURFACE_TARGETS, type SurfaceTarget } from './harness-registry.js'
import { classifySurfaceOwnership, type SurfaceDesiredEntry } from './ownership.js'

export type SelftestCapability = 'instruction-loading' | 'guard-firing' | 'skill-parity'

export type BuiltinHarnessRef =
    | Readonly<{ kind: 'builtin'; target: 'claudecode'; name: 'Claude Code' }>
    | Readonly<{ kind: 'builtin'; target: 'codexcli'; name: 'Codex' }>
    | Readonly<{ kind: 'builtin'; target: 'opencode'; name: 'OpenCode' }>

export interface CustomHarnessRef {
    readonly kind: 'custom'
    readonly id: string
    readonly declarationSha256: string
    readonly module: string
    readonly sourceSha256: string
    readonly export: string
}

export type SelftestHarnessRef = BuiltinHarnessRef | Readonly<CustomHarnessRef>

export type SelftestCellKey =
    | Readonly<{ harness: SelftestHarnessRef; capability: 'instruction-loading' | 'guard-firing' }>
    | Readonly<{ harness: SelftestHarnessRef; capability: 'skill-parity'; skill: string }>

export interface SelftestExpectation {
    readonly schema: 'cockpit-harness-selftest-expectation/v1'
    readonly generatedManifestSha256: string
    readonly cells: readonly SelftestCellKey[]
    readonly shippedSkills: readonly string[]
    readonly reviewHarnesses: readonly [
        Readonly<{ name: 'Claude Code'; nativeDiagnostics: false }>,
        Readonly<{ name: 'Codex'; nativeDiagnostics: true }>,
    ]
}

/**
 * A probe row exists only for a built-in tool. cockpit runs a probe through an executable it found
 * on PATH and the person approved by digest; a custom harness has no such executable, only a module
 * cockpit loads to render files, and running a worker command cockpit built around that module would
 * be cockpit vouching for itself. So a custom cell never gets a row: selftest records it
 * human_needed, and a row written for one is refused rather than accepted and ignored.
 */
export interface SelftestProbeSpecification {
    readonly harness: BuiltinHarnessRef
    readonly capability: SelftestCapability
    readonly invocation: readonly [string, ...string[]]
    readonly versionCommand: readonly [string, ...string[]]
    readonly helpCommand: readonly [string, ...string[]]
    readonly candidateCode: string
    readonly brokenCode: string
    readonly unavailableCode: string
    readonly sample: Readonly<{ skill: string; features: readonly ('name' | 'trigger' | 'body-load' | 'tools' | 'non-goals')[] }> | null
}

/**
 * A specification row as cockpit can write it. The fields left null are the probe itself: the
 * arguments that make a tool load a control file and the lines it prints for an accepted and a
 * rejected control. Nothing in the generated manifest says what those are for a given tool and
 * version, so a person supplies them and approves the whole file before anything in it runs.
 */
export type SelftestProbeSpecificationDraft = Omit<SelftestProbeSpecification, 'invocation' | 'candidateCode' | 'brokenCode' | 'sample'> & Readonly<{
    invocation: null
    candidateCode: null
    brokenCode: null
    sample: Readonly<{ skill: string; features: null }> | null
}>

export interface PlannedSelftestProbe extends SelftestProbeSpecification {
    readonly cell: SelftestCellKey
    readonly entries: readonly SurfaceDesiredEntry[]
}

export type SurfaceSelftestPlanResult =
    | Readonly<{
        kind: 'complete'
        expectation: SelftestExpectation
        probes: readonly PlannedSelftestProbe[]
        /** Custom cells: no probe can run for them, so each is recorded human_needed. */
        unprobeable: readonly SelftestCellKey[]
    }>
    | Readonly<{ kind: 'refusal'; code: 'SELFTEST_SOURCE_INVALID'; reason: string }>

export type SelftestHumanNeededRecord = Readonly<{
    kind: 'human_needed'
    harness: SelftestHarnessRef
    capability: 'instruction-loading' | 'guard-firing'
    generatedManifestSha256: string
    observedAt: string
    reason: 'executable_missing' | 'authentication_required' | 'isolation_unavailable' | 'enforcement_probe_required'
    operatorAction: string
}> | Readonly<{
    kind: 'human_needed'
    harness: SelftestHarnessRef
    capability: 'skill-parity'
    skill: string
    generatedManifestSha256: string
    observedAt: string
    reason: 'executable_missing' | 'authentication_required' | 'isolation_unavailable' | 'enforcement_probe_required'
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
const CUSTOM_ID = /^[a-z0-9][a-z0-9-]{0,127}$/
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/
const SAMPLE_FEATURES = new Set(['name', 'trigger', 'body-load', 'tools', 'non-goals'])
const CAPABILITIES = Object.freeze<SelftestCapability[]>(['instruction-loading', 'guard-firing', 'skill-parity'])
const BUILTINS = Object.freeze<Record<string, BuiltinHarnessRef>>({
    claudecode: Object.freeze({ kind: 'builtin', target: 'claudecode', name: 'Claude Code' }),
    codexcli: Object.freeze({ kind: 'builtin', target: 'codexcli', name: 'Codex' }),
    opencode: Object.freeze({ kind: 'builtin', target: 'opencode', name: 'OpenCode' }),
})
const FEATURE_CAPABILITY = Object.freeze<Partial<Record<SurfaceFeature, SelftestCapability>>>({
    rules: 'instruction-loading',
    hooks: 'guard-firing',
    permissions: 'guard-firing',
    skills: 'skill-parity',
})

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function cellKey(cell: SelftestCellKey): string {
    const harness = cell.harness.kind === 'builtin' ? cell.harness.target : cell.harness.id
    return `${cell.harness.kind}\0${harness}\0${cell.capability}\0${cell.capability === 'skill-parity' ? cell.skill : ''}`
}

type ProjectedCustomHarness = GeneratedSurfaceSelftestProjection['declarations'][number]

function declarationDigest(declaration: ProjectedCustomHarness): string | undefined {
    const captured = snapshotGeneratedJson(declaration)
    return captured === undefined ? undefined : digest(JSON.stringify(captured))
}

function customKey(harness: string, feature: SurfaceFeature): string {
    return `${harness}\0${feature}`
}

function customRef(
    declaration: ProjectedCustomHarness,
    capability: ProjectedCustomHarness['capabilities'][number],
    input: GeneratedCustomSurfaceSelftestInput,
): CustomHarnessRef | undefined {
    const declarationSha256 = declarationDigest(declaration)
    if (!declarationSha256 || !CUSTOM_ID.test(declaration.name) || SURFACE_TARGETS.includes(declaration.name as SurfaceTarget)
        || capability.state === 'unavailable'
        || capability.mechanism.module !== input.module || capability.mechanism.export !== input.export
        || capability.measured_on !== input.measuredOn || capability.state !== input.state
        || !SHA256.test(input.sourceSha256) || !SHA256.test(input.resultSha256)) return undefined
    return {
        kind: 'custom', id: declaration.name, declarationSha256,
        module: input.module, sourceSha256: input.sourceSha256, export: input.export,
    }
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
    const payload = {
        schema: captured.schema,
        configuredHarnesses: captured.configuredHarnesses,
        declarations: captured.declarations,
        entries: captured.entries,
        custom: captured.custom,
    }
    if (digest(JSON.stringify(payload)) !== captured.manifestSha256) return undefined
    const ownership = classifySurfaceOwnership({ configuredHarnesses: captured.configuredHarnesses, entries: captured.entries })
    if (ownership.kind !== 'complete') return undefined
    const configured = new Set(captured.configuredHarnesses)
    if (configured.size !== captured.configuredHarnesses.length
        || captured.configuredHarnesses.length > SURFACE_TARGETS.length + 64
        || [...configured].some((name) => !SURFACE_TARGETS.includes(name as SurfaceTarget)
            && !captured.declarations.some((row) => row.name === name))) return undefined
    if (captured.declarations.length > 64 || new Set(captured.declarations.map((row) => row.name)).size !== captured.declarations.length
        || captured.declarations.some((row) => !configured.has(row.name))) return undefined

    const inputs = new Map<string, GeneratedCustomSurfaceSelftestInput>()
    for (const input of captured.custom) {
        const key = customKey(input.harness, input.feature)
        if (inputs.has(key) || !configured.has(input.harness)) return undefined
        inputs.set(key, input)
    }
    const skills = shippedSkills(ownership.entries)
    if (!skills || skills.length === 0 || skills.length > 256) return undefined
    const cells: SelftestCellKey[] = []
    const usedInputs = new Set<string>()
    const customCells = new Map<string, SelftestCellKey>()
    for (const target of Object.keys(BUILTINS).sort(compareCodeUnits)) {
        if (!configured.has(target)) continue
        for (const capability of CAPABILITIES) {
            if (capability === 'skill-parity') {
                for (const skill of skills) cells.push({ harness: BUILTINS[target]!, capability, skill })
            } else cells.push({ harness: BUILTINS[target]!, capability })
        }
    }
    for (const declaration of captured.declarations) {
        for (const capability of declaration.capabilities) {
            const evidenceCapability = FEATURE_CAPABILITY[capability.feature]
            const inputKey = customKey(declaration.name, capability.feature)
            const input = inputs.get(inputKey)
            if (capability.state === 'unavailable') {
                if (input !== undefined) return undefined
                continue
            }
            if (!input) return undefined
            usedInputs.add(inputKey)
            if (!evidenceCapability) continue
            const harness = customRef(declaration, capability, input)
            if (!harness) return undefined
            const capabilitySkills = evidenceCapability === 'skill-parity' ? skills : [undefined]
            for (const skill of capabilitySkills) {
                const key = `${declaration.name}\0${evidenceCapability}\0${skill ?? ''}`
                const existing = customCells.get(key)
                if (existing) return undefined
                customCells.set(key, evidenceCapability === 'skill-parity'
                    ? { harness, capability: evidenceCapability, skill: skill! }
                    : { harness, capability: evidenceCapability })
            }
        }
    }
    cells.push(...customCells.values())
    if (inputs.size !== captured.custom.length || usedInputs.size !== inputs.size || cells.length === 0 || cells.length > 256) return undefined
    const uniqueCells = new Map(cells.map((cell) => [cellKey(cell), cell]))
    if (uniqueCells.size !== cells.length) return undefined
    return {
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
    return left.kind === right.kind && (left.kind === 'builtin'
        ? right.kind === 'builtin' && left.target === right.target && left.name === right.name
        : right.kind === 'custom' && left.id === right.id && left.declarationSha256 === right.declarationSha256
            && left.module === right.module && left.sourceSha256 === right.sourceSha256 && left.export === right.export)
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

function validProbe(probe: SelftestProbeSpecification, cell: SelftestCellKey): boolean {
    try {
    if (Object.keys(probe).sort().join('\0') !== [
        'brokenCode', 'candidateCode', 'capability', 'harness', 'helpCommand', 'invocation',
        'sample', 'unavailableCode', 'versionCommand',
    ].sort().join('\0')) return false
    if (probe.harness.kind !== 'builtin' || Object.keys(probe.harness).sort().join('\0') !== 'kind\0name\0target') return false
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

function harnessLabel(harness: SelftestHarnessRef): string {
    return harness.kind === 'builtin' ? harness.name : harness.id
}

/** `<harness> <capability>[ <skill>]`, the name a person sees for a cell. */
export function surfaceSelftestCellLabel(cell: SelftestCellKey): string {
    return `${harnessLabel(cell.harness)} ${cell.capability}${cell.capability === 'skill-parity' ? ` ${cell.skill}` : ''}`
}

function builtinCell(cell: SelftestCellKey): cell is SelftestCellKey & Readonly<{ harness: BuiltinHarnessRef }> {
    return cell.harness.kind === 'builtin'
}

/**
 * One row per built-in cell, with everything the generated manifest determines filled in and the
 * probe itself left null. The version and help commands are the identity probes every built-in tool
 * answers with `--version` and `--help`; they run before the controls and are shown for approval.
 * Custom cells get no row (see SelftestProbeSpecification) and are returned as `unprobeable`.
 *
 * A row from `previous` (an earlier file, usually stale after a config change) is kept as it is when
 * it is a complete, valid row for a cell that still exists, so the probes a person wrote survive the
 * rewrite; a row for a changed or removed cell, or one still partly null, is not carried.
 */
export function draftSurfaceSelftestSpecifications(
    projection: GeneratedSurfaceSelftestProjection,
    previous: readonly unknown[] = [],
): Readonly<{
    specifications: readonly (SelftestProbeSpecificationDraft | SelftestProbeSpecification)[]
    unprobeable: readonly SelftestCellKey[]
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
    const specifications = expectation.cells.filter(builtinCell).map((cell) => {
        const kept = earlier.get(cellKey(cell))
        if (kept && validProbe(kept, cell)) {
            carried += 1
            return kept
        }
        return {
            harness: cell.harness,
            capability: cell.capability,
            invocation: null,
            versionCommand: ['{executable}', '--version'] as const,
            helpCommand: ['{executable}', '--help'] as const,
            candidateCode: null,
            brokenCode: null,
            unavailableCode: `${cell.capability.replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`,
            sample: cell.capability === 'skill-parity' ? { skill: cell.skill, features: null } : null,
        }
    })
    return {
        specifications,
        unprobeable: expectation.cells.filter((cell) => !builtinCell(cell)),
        carried,
    }
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
        const label = harness !== null && typeof harness === 'object' ? harnessLabel(harness) : 'unknown harness'
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
    const customRows = capturedSpecifications.flatMap((row) => {
        const harness = (row as { harness?: unknown } | null)?.harness as SelftestHarnessRef | null | undefined
        return harness !== null && typeof harness === 'object' && harness.kind === 'custom'
            ? [`${typeof harness.id === 'string' ? harness.id : 'unknown harness'} ${String(row.capability)}`] : []
    })
    if (customRows.length > 0) return {
        kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID',
        reason: `probe specification rows for custom harnesses cannot run and would be ignored, so they are refused: ${customRows.slice(0, 5).join('; ')}${customRows.length > 5 ? `; and ${customRows.length - 5} more` : ''}; selftest records custom cells human_needed without a row, so delete these rows`,
    }
    const probeCells = expectation.cells.filter(builtinCell)
    if (capturedSpecifications.length !== probeCells.length || capturedSpecifications.length > 256) {
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
    for (const cell of probeCells) {
        const specification = byCell.get(cellKey(cell))
        if (!specification || !validProbe(specification, cell)) {
            return { kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: 'probe specification is malformed or does not match source authority' }
        }
        if (specification.sample && !expectation.shippedSkills.includes(specification.sample.skill)) {
            return { kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: 'skill parity sample is not a shipped skill' }
        }
        probes.push({
            ...specification,
            cell,
            entries: capturedProjection!.entries.filter((entry) => entry.harnesses.includes(cell.harness.target)),
        })
    }
    return {
        kind: 'complete', expectation, probes,
        unprobeable: expectation.cells.filter((cell) => !builtinCell(cell)),
    }
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
            operatorAction: `Review ${skill} with ${harness.name} and record the five authoring checks`,
        })
    }
    return reviews
}
