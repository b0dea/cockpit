import { cockpitCommand, type FixContext } from '../../fix-catalogue.js'
import { proposeGeneratedEnvironmentRepair } from '../../repair.js'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProxy } from 'node:util/types'
import { parseDocument } from 'yaml'
import { observeConfigSource, type ConsumedWorkEnvironmentConfig } from '../../config/load.js'
import type { BrowserRuntimeProjection } from '../../browser/runtime.js'
import type { Diagnostic } from '../../diagnostics.js'
import { executeProbe, type ExecuteProbeOutcome } from '../../environment-exec/execute.js'
import type { DerivedRegistry } from '../../registry-derivation.js'
import type { SurfaceFeature, SurfaceSourceFile, SurfaceTarget } from '../../surfaces/contract.js'
import type { SurfaceGenerationWarning } from '../../surfaces/generator-adapter.js'
import type { ActiveSurfaceOverride, SurfaceUpgradeFinding } from '../../surfaces/merge.js'
import { CORE_EVALUATOR_ASSET as EVALUATOR_ASSET, CORE_SKILL_ASSETS as SKILL_ASSETS } from '../../surfaces/core-declarations.js'
import type { McpDiagnostic, McpServer, McpStdioDeclaration } from '../../surfaces/mcp.js'
import {
    encodeOwnershipManifest,
    projectGeneratedPathFacts,
    type GeneratedPathFact,
    type GeneratedPathDeclaration,
    type GeneratedProducer,
    type SurfaceDesiredEntry,
} from '../../surfaces/ownership.js'
import type { DirectoryGrant, GuideObservation, GuideObservationRequest, StandingCost } from '../../surfaces/projection.js'
import type { NativeFragmentSet, SurfaceInputEvidence } from '../../surfaces/render.js'
import { encodeGuardLocalIdentity, GUARD_LOCAL_PATHS, type GuardHandlerIdentity } from '../../guards/local-identity.js'
import type { InspectedBootstrapOutputs, SkillStandingCost } from '../../surfaces/skill-contract.js'
import type {
    AnchoredBatchReadResult,
    DirectoryIdentity,
    FileIdentity,
    GeneratedStaleRemovalApprovalRequest,
    GeneratedStaleRemovalApproval,
    PublicationPlan,
} from '../../generated-environment/transaction.js'
import { ENVIRONMENT_CODES, errorCause, type EnvironmentObservation, type ExecutionStep, type CockpitId, hasErrorCode } from '../contract.js'
import type { ResolvedExecutable } from '../executable.js'
import { cockpitId, stackId } from '../identity.js'
import type { BootstrapStateAddress, BootstrapStateRecord, StateNamespace, StateResult } from '../state.js'
import type { GateRegistry } from '../../testing/gates.js'
import type { GeneratedCheckoutIdentity } from '../setup-observation.js'
import { refusalOutcome as refuse } from '../../refusal.js'
import { GUARD_HELD_CALLS } from '../../surfaces/harness-registry.js'

export const OWNER = 'generated-environment-application'

export const surfaceObservationDeclarations = Object.freeze([
    { id: 'harness-surfaces', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
    { id: 'directory-grants', owner: OWNER, postures: ['directory-grants'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
    { id: 'guide-budget', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
    { id: 'skill-budget', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
] as const)

export const issuedSurfaceObservations = new WeakMap<object, number>()

export interface GeneratedEnvironmentCommandInput {
    readonly configPath: string
}

export interface GeneratedEnvironmentSyncInput extends GeneratedEnvironmentCommandInput {
    readonly dryRun?: boolean
    readonly bootstrapState?: Readonly<{
        readonly publication: StateResult<BootstrapStateRecord>
        readonly address: BootstrapStateAddress
    }>
}

export interface SelectedBootstrapSurfaceInput {
    readonly root: string
    readonly target: SurfaceTarget
    /** Every tool in `[surfaces] tools`, `target` first; each gets the setup skill before the interview. */
    readonly tools: readonly SurfaceTarget[]
}

export interface SelectedBootstrapPublicationAuthority {
    readonly kind: 'selected-bootstrap-publication-authority'
}

export interface SelectedBootstrapSurfaceResult {
    readonly root: string
    readonly target: SurfaceTarget
    readonly sources: readonly Readonly<{ path: string; sha256: string }>[]
    readonly files: readonly Readonly<{ path: string; sha256: string }>[]
    readonly previewSha256: string
    readonly changes: readonly GeneratedEnvironmentChange[]
}

export type SelectedBootstrapSurfaceOutcome = RefusalOutcome | Readonly<{
    kind: 'complete'
    artifact: null
    destination: null
    diagnostics: readonly Diagnostic[]
    result: SelectedBootstrapSurfaceResult
    authority: SelectedBootstrapPublicationAuthority
    status: 0
}>

export interface SelectedBootstrapResumeInput extends SelectedBootstrapSurfaceInput {
    readonly address: BootstrapStateAddress
    readonly expectedRevision?: number
    readonly expectedCommandSha256?: string
}

export type SelectedBootstrapResumeOutcome = RefusalOutcome
    | Readonly<{ kind: 'pending'; status: 0; diagnostics: readonly Diagnostic[]; result: null; canonicalOwnership: false }>
    | Readonly<{ kind: 'refresh'; status: 0; diagnostics: readonly Diagnostic[];
        result: SelectedBootstrapSurfaceResult; authority: SelectedBootstrapPublicationAuthority; canonicalOwnership: false }>
    | Readonly<{ kind: 'complete'; status: 0; diagnostics: readonly Diagnostic[];
        result: SelectedBootstrapSurfaceResult; canonicalOwnership: true }>

export interface GeneratedEnvironmentChange {
    readonly operation: 'write' | 'remove'
    readonly path: string
}

export interface GeneratedEnvironmentCommandAdapters {
    /** Observation callers select their tool search path without replacing the process environment. */
    readonly observationEnv?: Readonly<Record<string, string | undefined>>
    readonly now?: () => string
    readonly observeSource: typeof observeConfigSource
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    readonly authorizeStaleRemoval?: (
        request: GeneratedStaleRemovalApprovalRequest,
    ) => Promise<GeneratedStaleRemovalApproval | undefined>
}

export type { GeneratedStaleRemovalApprovalEntry, GeneratedStaleRemovalApprovalRequest, GeneratedStaleRemovalApproval } from '../../generated-environment/transaction.js'

export interface OwnedBytes {
    readonly path: string
    readonly bytes: string
    readonly sha256: string
}

export interface PreparedEnvironment {
    readonly root: string
    readonly cockpitId: CockpitId
    readonly stackId: ReturnType<typeof stackId>
    readonly checkoutIdentity: GeneratedCheckoutIdentity
    readonly configPath: string
    readonly sourceSha256: string
    readonly runtimeSha256: string
    readonly configSource: Readonly<{ path: string; sha256: string }>
    readonly configSourceIdentity: FileIdentity
    readonly generation: string
    readonly generated: readonly OwnedBytes[]
    readonly owned: readonly OwnedBytes[]
    readonly surfaces: readonly SurfaceDesiredEntry[]
    readonly compactSurfacePaths: ReadonlySet<string>
    readonly configuredHarnesses: readonly string[]
    readonly activeSurfaceOverrides: readonly ActiveSurfaceOverride[]
    readonly changedOverrideOriginals: readonly SurfaceUpgradeFinding[]
    readonly surfaceSelftest?: GeneratedSurfaceSelftestProjection
    readonly surfaceHealth?: GeneratedSurfaceHealthEvidence
    readonly guideSources: Readonly<{
        readonly requests: readonly GuideObservationRequest[]
        readonly observations: readonly GuideObservation[]
        readonly missing: readonly string[]
    }>
    readonly sourceEvidence: readonly SurfaceInputEvidence[]
    readonly sourceRoots: readonly SourceRootIdentity[]
    readonly customSources: readonly CustomSourceIdentity[]
    // The team's adopted harness settings copies a merged surface was rendered from.
    readonly adoptedSources: readonly AdoptedSourceIdentity[]
    readonly nativeHookPolicySource?: Readonly<{ path: string; sha256: string; identity: FileIdentity }>
    // The declared Compose files the ownership override was rendered from, re-read before publication.
    readonly composeSources: readonly Readonly<{ path: string; sha256: string; identity: FileIdentity }>[]
    readonly surfaceAssets: readonly SurfaceAssetIdentity[]
    readonly warnings: readonly SurfaceGenerationWarning[]
    // Declared MCP servers left out of `[mcp].approved`: rendered disabled, and said so on every sync and check.
    readonly unapprovedMcpServers: readonly Readonly<{ name: string; sources: readonly string[]; sha256: string }>[]
    // Declared remote servers a listed tool cannot carry the credential of: left out of that tool's file.
    readonly mcpTransportGaps: readonly Readonly<{ name: string; targets: readonly string[]; reason: string }>[]
    // Every declared MCP server as rendered, so doctor can check what each one needs to start.
    readonly mcpServers: readonly McpServer[]
    readonly registry: DerivedRegistry
    readonly siblingRoots: AuthenticatedSiblingRoots
    readonly workEnvironment: ConsumedWorkEnvironmentConfig
    readonly workApplication?: WorkApplicationAuthorityRecord
    readonly node: ResolvedExecutable
    readonly guardHandler?: GuardHandlerIdentity
    // Each mounted sibling's absolute directory, which `sync` writes to machine-local files that the
    // committed OpenCode grant reads; see openCodeExternalDirectories.
    readonly openCodeGrantRoots: readonly Readonly<{ slug: string; root: string }>[]
    readonly now: string
    readonly producedAt: string
}

function containedPath(root: string, candidate: string): boolean {
    const fromRoot = relative(root, candidate)
    return fromRoot === '' || fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

interface AuthenticatedSiblingRoots {
    readonly declaredRoot: string
    readonly canonicalRoot: string
    readonly rootIdentity: DirectoryIdentity
    readonly siblings: ReadonlyMap<string, Readonly<{ root: string; identity: DirectoryIdentity }>>
}

export function activeClaudeImports(bytes: string): readonly number[] {
    const imports: number[] = []
    let fence: Readonly<{ marker: '`' | '~'; length: number }> | undefined
    let inComment = false
    for (const [index, line] of bytes.split(/\r?\n/u).entries()) {
        const trimmed = line.trimStart()
        const marker = /^ {0,3}(?<fence>`{3,}|~{3,})(?<suffix>.*)$/u.exec(line)?.groups
        if (fence) {
            if (marker?.fence?.[0] === fence.marker && marker.fence.length >= fence.length
                && marker.suffix?.trim() === '') fence = undefined
            continue
        }
        if (inComment) {
            if (trimmed.includes('-->')) inComment = false
            continue
        }
        if (trimmed.startsWith('<!--')) {
            if (!trimmed.includes('-->')) inComment = true
            continue
        }
        if (marker?.fence && (marker.fence[0] !== '`' || !marker.suffix?.includes('`'))) {
            fence = { marker: marker.fence[0] as '`' | '~', length: marker.fence.length }
            continue
        }
        if (line === '@AGENTS.md') imports.push(index)
    }
    return imports
}

export async function siblingRootsCurrent(authority: AuthenticatedSiblingRoots): Promise<boolean> {
    try {
        if (await realpath(authority.declaredRoot) !== authority.canonicalRoot) return false
        const root = await lstat(authority.canonicalRoot)
        if (!root.isDirectory() || root.isSymbolicLink()
            || root.dev !== authority.rootIdentity.dev || root.ino !== authority.rootIdentity.ino) return false
        for (const sibling of authority.siblings.values()) {
            const canonical = await realpath(sibling.root)
            const status = await lstat(canonical)
            if (canonical !== sibling.root || !containedPath(authority.canonicalRoot, canonical)
                || !status.isDirectory() || status.isSymbolicLink()
                || status.dev !== sibling.identity.dev || status.ino !== sibling.identity.ino) return false
        }
        return true
    } catch {
        // a failed re-observation means the root is no longer authenticated; the caller refuses.
        return false
    }
}

// A teammate's clone of a cockpit has none of its siblings until setup clones them; a sibling
// setup cannot clone was reported as a bare realpath ENOENT with nothing to do about it.
function absentSibling(sibling: DerivedRegistry['config']['sibling'][number], path: string, configPath: string) {
    const setup = cockpitCommand('setup', { config: configPath })
    const fix = sibling.acquire === 'auto' ? `run ${setup}, which clones ${sibling.remote} there, then rerun this command`
        : sibling.acquire === 'manual' ? `clone ${sibling.remote} into ${path}, then rerun this command`
            : `clone or create the repository at ${path}, then rerun this command; cockpit.toml records no remote for it (acquire = "none"), so setup cannot clone it: whoever has the checkout records one with ${cockpitCommand('sibling add', { operand: sibling.slug, config: configPath, args: '--remote <url>' })} and commits cockpit.toml, and every later ${setup} clones it`
    return {
        kind: 'refusal' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'SIBLING_MISSING' satisfies typeof ENVIRONMENT_CODES.SIBLING_MISSING,
        reason: `sibling ${sibling.slug} is declared at ${path}, and nothing is there`,
        target: `sibling:${sibling.slug}`,
        fix,
    }
}

export async function authenticateSiblingRoots(
    root: string,
    config: DerivedRegistry['config'],
    configPath: string,
): Promise<Readonly<{ kind: 'complete'; roots: AuthenticatedSiblingRoots }>
    | Readonly<{ kind: 'refusal'; reason: string; code?: string; target?: string; fix?: string }>> {
    try {
        const declaredRoot = resolve(root, config.cockpit.siblings_root)
        const canonicalRoot = await realpath(declaredRoot)
        const rootStatus = await lstat(canonicalRoot)
        if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
            return { kind: 'refusal', reason: 'the declared sibling root is not an ordinary directory' }
        }
        const siblings = new Map<string, Readonly<{ root: string; identity: DirectoryIdentity }>>()
        for (const sibling of config.sibling) {
            const declared = resolve(declaredRoot, sibling.dir)
            if (!containedPath(declaredRoot, declared)) {
                return { kind: 'refusal', reason: `sibling ${sibling.slug} escapes the declared sibling root` }
            }
            const present = await lstat(declared).then(() => true, (error: unknown) => {
                if (hasErrorCode(error, 'ENOENT')) return false
                throw error
            })
            if (!present) return absentSibling(sibling, declared, configPath)
            const canonical = await realpath(declared)
            const status = await lstat(canonical)
            if (!containedPath(canonicalRoot, canonical)) {
                return { kind: 'refusal', reason: `sibling ${sibling.slug} resolves outside the declared sibling root` }
            }
            if (!status.isDirectory() || status.isSymbolicLink()) {
                return { kind: 'refusal', reason: `sibling ${sibling.slug} is not an ordinary directory` }
            }
            siblings.set(sibling.slug, { root: canonical, identity: { dev: status.dev, ino: status.ino } })
        }
        return { kind: 'complete', roots: {
            declaredRoot, canonicalRoot, rootIdentity: { dev: rootStatus.dev, ino: rootStatus.ino }, siblings,
        } }
    } catch (error) {
        const reason = errorCause(error)
        return { kind: 'refusal', reason: `could not verify the sibling root (${reason})` }
    }
}

export interface SourceRootIdentity {
    readonly slug: string
    readonly root: string
    readonly identity: DirectoryIdentity
}

export interface AdoptedSourceIdentity {
    readonly path: string
    readonly sha256: string
    readonly identity: FileIdentity
}

export interface CustomSourceIdentity {
    readonly harness: string
    readonly feature: SurfaceFeature
    readonly path: string
    readonly sha256: string
    readonly identity: FileIdentity
    readonly maxBytes: number
}

interface SurfaceAssetIdentity {
    readonly path: SurfaceAssetPath
    readonly sha256: string
    readonly identity: FileIdentity
}

interface CommandResult {
    readonly action: 'sync' | 'check'
    readonly dryRun: boolean
    readonly changes: readonly GeneratedEnvironmentChange[]
    readonly generation: string
    readonly sourceSha256: string
    readonly paths: readonly string[]
    readonly application: GeneratedApplicationProjection
    readonly staleRemoval?: GeneratedStaleRemovalApprovalRequest
}

export interface GeneratedApplicationProjection {
    readonly generatedPaths: readonly GeneratedPathFact[]
    readonly sourceSha256: string
    /** The stack identity the generated files were rendered for; see `runtimeDeclarationSha256`. */
    readonly runtimeSha256: string
    readonly generation: string
    readonly activeSurfaceOverrides: readonly ActiveSurfaceOverride[]
    readonly changedOverrideOriginals: readonly SurfaceUpgradeFinding[]
    readonly inspection: Readonly<{
        readonly kind: 'passed'
        readonly files: readonly Readonly<{ path: string; sha256: string; ownership: 'whole-file' }>[]
    }>
    readonly surfaceSelftest: GeneratedSurfaceSelftestProjection
}

export interface WorkApplicationAuthoritiesProjection {
    readonly kind: 'work-application-authorities'
}

export interface ConsumedWorkApplicationAuthorities {
    readonly workEnvironment: ConsumedWorkEnvironmentConfig
    readonly evaluator: Readonly<{
        readonly path: string
        readonly bytes: string
        readonly sha256: string
        readonly identity: FileIdentity
        readonly restriction: 'instructed'
    }>
    readonly installedSkills: readonly Readonly<{
        readonly path: string
        readonly sha256: string
    }>[]
    readonly browser?: Readonly<{
        readonly runtime: BrowserRuntimeProjection
        readonly namespace: StateNamespace
        readonly mcp: McpStdioDeclaration
        readonly skillTemplate: Readonly<{
            readonly path: string
            readonly bytes: string
            readonly sha256: string
            readonly identity: FileIdentity
        }>
    }>
    readonly testing: Readonly<{ readonly registry: GateRegistry }>
}

export interface GeneratedCustomSurfaceSelftestInput {
    readonly harness: string
    readonly feature: SurfaceFeature
    readonly state: 'enforced' | 'instructed'
    readonly measuredOn: string
    readonly module: string
    readonly export: string
    readonly sourceSha256: string
    readonly resultSha256: string
    readonly sources: readonly Readonly<SurfaceSourceFile>[]
    readonly evidence?: Readonly<{ reference: string; sha256: string }>
}

export interface GeneratedSurfaceSelftestProjection {
    readonly schema: 'cockpit-generated-surface-selftest/v1'
    readonly configuredHarnesses: readonly string[]
    readonly declarations: DerivedRegistry['config']['surfaces']['harnesses']
    readonly entries: readonly SurfaceDesiredEntry[]
    readonly custom: readonly GeneratedCustomSurfaceSelftestInput[]
    readonly manifestSha256: string
    readonly guardProbeHost?: string
    /** The exact command of cockpit's own Claude Code guard hook, the one the guard probe breaks. */
    readonly guardHookCommand?: string
    /** Every command cockpit generated in Claude Code's hook settings; the file's other hooks are the team's. */
    readonly cockpitHookCommands?: readonly string[]
    /**
     * The team's own CLAUDE.md as sync read it, when it already imports AGENTS.md once and cockpit
     * therefore leaves it in place instead of owning one; the Claude instruction probe loads through it.
     */
    readonly teamClaudeGuide?: string
}

export interface GeneratedSurfaceHealthEvidence {
    readonly observedAt: string
    readonly grants: readonly DirectoryGrant[]
    readonly nativeGrants: NativeFragmentSet
    readonly guideCosts: readonly StandingCost[]
    readonly skillCosts: readonly SkillStandingCost[]
    readonly skillCollectionSha256: string
    readonly skillInventorySha256: string
    readonly skillInventory: readonly Readonly<{ target: string; path: string; sha256: string }>[]
    readonly skills: readonly string[]
}

interface CompleteOutcome {
    readonly kind: 'complete'
    readonly artifact: null
    readonly destination: null
    readonly diagnostics: readonly Diagnostic[]
    readonly result: CommandResult
    readonly status: 0
}

export interface RefusalOutcome {
    readonly kind: 'refusal'
    readonly artifact: null
    readonly destination: null
    readonly diagnostics: readonly Diagnostic[]
    readonly result: null
    readonly status: 2
}

export type GeneratedEnvironmentCommandOutcome = (CompleteOutcome | RefusalOutcome) & Readonly<{
    fixContext?: FixContext
    report?: Readonly<{
        storedProducer: GeneratedProducer | null
        currentProducer: GeneratedEnvironmentCurrentness['currentProducer']
        repair: ReturnType<typeof proposeGeneratedEnvironmentRepair>
    }>
}>

export const defaultAdapters: GeneratedEnvironmentCommandAdapters = { observeSource: observeConfigSource, execute: executeProbe }
export const OWNERSHIP_PATH = '.cockpit/generated-environment-ownership.json'
export const SHA256 = /^[a-f0-9]{64}$/
export const MAX_OWNERSHIP_BYTES = 1_048_576
export const COMPOSE_SOURCE_BYTES = 1_048_576
export const MAX_OWNED_FILES = 256
export const MAX_EXECUTABLE_BYTES = 536_870_912
export const MAX_GENERATED_BYTES = 16_777_216
export const MAX_SURFACE_FILE_BYTES = 65_536
const MAX_SURFACE_BYTES = 4_194_304
export const MAX_HELPER_FRAME_BYTES = 65_536
export const HELPER_TIMEOUT_MS = 10_000
// The native hook cost workload spawns Git once per ref update, 128 times. On a loaded host that
// takes seconds (7 s at a load average of 24), so under the helper bound an over-budget hook timed
// out and was reported as a failed execution instead of being sent to CI.
export const NATIVE_HOOK_COST_TIMEOUT_MS = 60_000
export const SURFACE_ROOT = fileURLToPath(new URL('../../../surfaces', import.meta.url))
export const RESTRICTION_ASSETS = Object.freeze([
    'guards/bash-guard.sh',
    'guards/claude.adapter.json',
    'guards/codex.adapter.json',
    'guards/opencode.adapter.json',
] as const)
// Shipped beside the setup skill, outside the skill contract: the skill set admits only entry points and the
// shared procedure, and these are pulled on demand like the browser reference.
export const REFERENCE_ASSETS = Object.freeze([
    'references/test-data-and-personas.md',
] as const)
export const WORK_ASSETS = Object.freeze([
    'skills/cockpit-browser.skill.md',
    'references/browser.md',
    'references/testing-tiers.md',
] as const)
export type SurfaceAssetPath = typeof RESTRICTION_ASSETS[number] | typeof EVALUATOR_ASSET | typeof SKILL_ASSETS[number] | typeof REFERENCE_ASSETS[number] | typeof WORK_ASSETS[number]
interface GeneratedApplicationRecord {
    readonly root: string
    readonly stackId: ReturnType<typeof stackId>
    readonly currentPublication: true | false
    readonly guardRuntime?: readonly Readonly<{ path: string; sha256: string; maxBytes: number }>[]
    /** The guard identity this process's sync would write; selftest compares the installed one before any approval. */
    readonly guardHandler?: GuardHandlerIdentity
    readonly siblingRoots: AuthenticatedSiblingRoots
    readonly node: ResolvedExecutable
    readonly workApplication?: WorkApplicationAuthorityRecord
    readonly surfaceSelftest: GeneratedSurfaceSelftestProjection
    readonly surfaceHealth: GeneratedSurfaceHealthEvidence
}

export type WorkApplicationAuthorityRecord = ConsumedWorkApplicationAuthorities

export const issuedApplicationProjections = new WeakMap<object, GeneratedApplicationRecord>()
export const projectedWorkApplicationAuthorities = new WeakSet<object>()
export const issuedWorkApplicationAuthorities = new WeakMap<object, WorkApplicationAuthorityRecord>()

export interface SelectedBootstrapRecord {
    readonly root: string
    readonly rootIdentity: DirectoryIdentity
    readonly target: SurfaceTarget
    readonly node: ResolvedExecutable
    readonly assets: readonly SurfaceAssetIdentity[]
    readonly inspected: InspectedBootstrapOutputs
    readonly result: SelectedBootstrapSurfaceResult
    readonly plan: PublicationPlan
    readonly adapters: GeneratedEnvironmentCommandAdapters
    readonly bootstrapState?: Readonly<{ address: BootstrapStateAddress; record: BootstrapStateRecord }>
}

export const issuedSelectedBootstrapAuthorities = new WeakMap<object, SelectedBootstrapRecord>()
export const consumedBootstrapStatePublications = new WeakSet<object>()

export function skillDescription(bytes: string): string | undefined {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(bytes)?.[1]
    if (front === undefined) return undefined
    const description = (parseDocument(front).toJS({ maxAliasCount: 0 }) as { description?: unknown } | null)?.description
    return typeof description === 'string' ? description : undefined
}

export const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

export function sha256(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex')
}

export function ownRecord(value: unknown): Record<string, unknown> | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Object.getOwnPropertySymbols(value).length > 0
            || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) return undefined
        return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
    } catch {
        // a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses.
        return undefined
    }
}

export function guideLines(bytes: string): number {
    return bytes.trimEnd().split('\n').length
}

// An overlay pins the digest of the built-in it replaces, so a cockpit upgrade that changes that
// built-in is reviewed before the override keeps shadowing it.
function overrideChanged(finding: SurfaceUpgradeFinding, severity: 'error' | 'warning') {
    return {
        severity, code: 'OVERRIDDEN_CORE_CHANGED' as const satisfies SurfaceUpgradeFinding['code'], target: finding.overlaySource,
        message: `overlay ${finding.name} replaces the built-in ${finding.name} recorded as sha256 ${finding.recordedSha256}, but this cockpit version's built-in is sha256 ${finding.currentSha256}`,
        fix: 'review the new built-in against your override, set the overlay\'s replaces.sha256 to the current digest this message names, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>',
    }
}

// Copied sibling guides count toward the cap, so a sibling's own edit can push it over.
export function guideCapExceeded(cost: Readonly<{ target: string; value: number; cap: number }>): RefusalOutcome {
    return { kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [{
            severity: 'error' as const, code: ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED, target: 'cockpit.guide_cap',
            message: `the instructions ${cost.target} loads at start are ${cost.value} lines, over cockpit.guide_cap ${cost.cap}; the count includes each sibling guide copied into the root AGENTS.md`,
            fix: 'shorten the root or sibling guides, or move conditional guidance into a skill, or raise cockpit.guide_cap in cockpit.toml, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>',
        }] }
}

// Codex 0.166.0 dropped the end of a project AGENTS.md past 32 KiB without saying so (measured
// 2026-11-03), and the copied sibling guides sit at the end of cockpit's region. The team's own text
// outside the region counts too, so this is the least the file holds.
export const CODEX_PROJECT_DOC_BYTES = 32_768

export function guideBytesExceeded(bytes: number): RefusalOutcome {
    return { kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [{
            severity: 'error' as const,
            // A literal, so the diagnostic inventory captures the fix beside the code.
            code: 'GUIDE_CAP_EXCEEDED' as const satisfies typeof ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED,
            target: 'AGENTS.md',
            message: `cockpit's part of the root AGENTS.md, with the sibling guides it copies, is ${bytes} bytes; Codex drops whatever follows the first 32768 bytes of a project AGENTS.md without saying so`,
            fix: 'shorten the root or sibling guides, or name fewer guides in sibling.guides, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>',
        }] }
}

// The projection skips an absent guide, so a misspelled name otherwise copies nothing and says nothing.
export function siblingGuideMissing(slug: string, guide: string, sourcePath: string): RefusalOutcome {
    return { kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [{
            severity: 'error' as const,
            code: 'SIBLING_GUIDE_MISSING' as const satisfies typeof ENVIRONMENT_CODES.SIBLING_GUIDE_MISSING,
            target: `sibling.${slug}.guides`,
            message: `sibling ${slug} declares the guide ${guide}, but ${sourcePath} does not exist, so no harness would load it`,
            fix: 'correct or remove the guide name in that sibling\'s guides list in cockpit.toml, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>',
        }] }
}

export function overrideChangedRefusal(finding: SurfaceUpgradeFinding): RefusalOutcome {
    return { kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [overrideChanged(finding, 'error')] }
}

export function complete(
    action: CommandResult['action'],
    prepared: PreparedEnvironment,
    dryRun = false,
    changes: readonly GeneratedEnvironmentChange[] = [],
    staleRemoval?: GeneratedStaleRemovalApprovalRequest,
): CompleteOutcome | RefusalOutcome {
    if (!prepared.surfaceSelftest || !prepared.surfaceHealth) return refuse('SURFACE_INPUT_INVALID', 'authenticated surface health inputs are missing', 'surfaces')
    const generatedPaths = generatedPathFacts(prepared, dryRun ? 'declared-before-sync' : 'required-after-sync')
    if (generatedPaths.kind !== 'complete') return refuse(generatedPaths.diagnostic.code, generatedPaths.diagnostic.message, generatedPaths.diagnostic.target)
    const application = {
        generatedPaths: generatedPaths.facts,
        sourceSha256: prepared.sourceSha256,
        runtimeSha256: prepared.runtimeSha256,
        generation: prepared.generation,
        surfaceSelftest: prepared.surfaceSelftest,
        activeSurfaceOverrides: prepared.activeSurfaceOverrides,
        changedOverrideOriginals: prepared.changedOverrideOriginals,
        inspection: {
            kind: 'passed' as const,
            files: prepared.owned.map(({ path, sha256: digest }) => ({ path, sha256: digest, ownership: 'whole-file' as const })),
        },
    }
    issuedApplicationProjections.set(application, Object.freeze({
        root: prepared.root, stackId: prepared.stackId, currentPublication: !dryRun,
        siblingRoots: prepared.siblingRoots,
        node: prepared.node, surfaceSelftest: prepared.surfaceSelftest, surfaceHealth: prepared.surfaceHealth,
        ...(prepared.guardHandler ? { guardHandler: prepared.guardHandler, guardRuntime: Object.freeze([
            { path: join(prepared.root, GUARD_LOCAL_PATHS.identity), sha256: sha256(encodeGuardLocalIdentity(prepared.guardHandler)), maxBytes: 65_536 },
            { path: join(prepared.root, GUARD_LOCAL_PATHS.generatedConfig), sha256: prepared.sourceSha256, maxBytes: MAX_GENERATED_BYTES },
            { path: prepared.configPath, sha256: prepared.sourceSha256, maxBytes: MAX_GENERATED_BYTES },
            { path: prepared.guardHandler.node, sha256: prepared.guardHandler.nodeSha256, maxBytes: 536_870_912 },
            { path: prepared.guardHandler.module, sha256: prepared.guardHandler.moduleSha256, maxBytes: MAX_GENERATED_BYTES },
            ...prepared.surfaceSelftest.entries.flatMap(entry => entry.path === '.cockpit/guards/bash-guard.sh' && entry.kind === 'file'
                ? [{ path: join(prepared.root, entry.path), sha256: entry.sha256, maxBytes: MAX_SURFACE_FILE_BYTES }] : []),
        ].map(row => Object.freeze(row))) } : {}),

        ...(!dryRun && prepared.workApplication ? { workApplication: prepared.workApplication } : {}),
    }))
    return {
        kind: 'complete', artifact: null, destination: null,
        diagnostics: [
            ...prepared.checkoutIdentity.standaloneReason ? [{
                severity: 'warning' as const, code: 'GENERATED_CHECKOUT_STANDALONE' as const, target: prepared.configPath,
                message: `this directory was treated as standalone, not as a Git checkout, because ${prepared.checkoutIdentity.standaloneReason}; generated files stay valid, but the guard needs a Git repository it can read and holds ${GUARD_HELD_CALLS} until it has one`,
                fix: 'in a terminal, outside the agent, run git init if this directory has no repository, remove a stale .git entry or repair it with git worktree repair, and install Git on an absolute PATH entry if it is missing; held calls then continue without a sync',
            }] : [],
            // A trust warning is a review prompt for settings being written; repeating it for an
            // unchanged file on every sync and check trained people to ignore it.
            ...prepared.warnings.filter(warning => changes.some(change => change.operation === 'write' && change.path === warning.path))
                .map(({ severity, code, target, path, message }) => ({
                    severity, code, target: `${target}:${path}`, message,
                })),
            ...prepared.unapprovedMcpServers.map(server => ({
                severity: 'warning' as const, code: 'MCP_NOT_APPROVED' as const satisfies McpDiagnostic['code'], target: server.name,
                message: `MCP server ${server.name}, declared in ${server.sources.join(', ')}, has no approval in [mcp.approved] for its current declaration (command, arguments, working directory and environment names for a local server; URL, header references and headers helper for a remote one) (sha256 ${server.sha256}), so every harness keeps it disabled`,
                fix: 'a person reviews its declaration, sets its name to the sha256 in this message under [mcp.approved] in cockpit.toml and runs ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>; while [autonomy] mcp_approve is person, the default, the guard refuses an agent enabling or changing approvals or widening tool access. Agents may remove unchanged approvals and add or narrow exact tool allowlists under [mcp.allowed_tools]. To keep it off, nothing is needed',
            })),
            ...prepared.mcpTransportGaps.map(gap => ({
                severity: 'warning' as const, code: 'MCP_TRANSPORT_UNAVAILABLE' as const satisfies McpDiagnostic['code'], target: gap.name,
                message: `${gap.reason}, so sync writes nothing for it there and the server is unavailable in those tools`,
                fix: 'nothing is needed if the server is not wanted in those tools; otherwise declare it with credentials the tool can carry (an environment reference in headers rather than a headersHelper for OpenCode), or remove those tools from [surfaces] tools, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>',
            })),
            // Real sync and check refuse a changed original; a preview reports it so it can be reviewed.
            ...prepared.changedOverrideOriginals.map(finding => overrideChanged(finding, 'warning')),
        ],
        status: 0,
        result: {
            action,
            dryRun,
            changes,
            generation: prepared.generation,
            sourceSha256: prepared.sourceSha256,
            paths: [...prepared.owned.map(({ path }) => path), ...prepared.surfaces.map(({ path }) => path)].sort(compareCodeUnits),
            application,
            ...(staleRemoval ? { staleRemoval } : {}),
        },
    }
}

export function generatedPathFacts(prepared: PreparedEnvironment, applicability: 'declared-before-sync' | 'required-after-sync') {
    const manifest = encodeOwnershipManifest(prepared).manifest
    const declarations: GeneratedPathDeclaration[] = [
        ...prepared.generated.map(file => ({ producer: 'generated-environment' as const, applicability,
            entry: manifest.entries.find(entry => entry.path === file.path)! })),
        ...prepared.surfaces.map(file => ({ producer: 'surface-render' as const, applicability,
            entry: manifest.entries.find(entry => entry.path === file.path)! })),
    ]
    return projectGeneratedPathFacts(manifest, { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath }, declarations)
}

function isGeneratedApplicationSurfaceObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedSurfaceObservations.has(value)
}

function generatedApplicationSurfaceObservationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedSurfaceObservations.get(value) : undefined
}

export function confined(root: string, path: string): string | undefined {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) return undefined
    const target = resolve(root, path)
    const offset = relative(root, target)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset) ? target : undefined
}

export function sourceIdentity(identity: FileIdentity): string {
    return JSON.stringify({ root: identity.root, chain: identity.chain, file: identity.file })
}

export function readSurfaceAsset(
    path: SurfaceAssetPath,
    read: AnchoredBatchReadResult,
): Readonly<{ path: SurfaceAssetPath; bytes: string; sha256: string; identity: FileIdentity }> | undefined {
    if (read.kind !== 'complete') return undefined
    try {
        return { path, bytes: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes),
            sha256: read.sha256, identity: read.identity }
    } catch { /* undecodable bytes are malformed input the caller refuses. */ return undefined }
}

export function mergedAdapters(overrides: Partial<GeneratedEnvironmentCommandAdapters>): GeneratedEnvironmentCommandAdapters {
    return { ...defaultAdapters, ...overrides }
}

export interface GeneratedEnvironmentRepairAuthority {
    readonly kind: 'generated-environment-repair'
}

export interface GeneratedEnvironmentCurrentness {
    readonly outcome: GeneratedEnvironmentCommandOutcome
    readonly changes: readonly GeneratedEnvironmentChange[]
    readonly storedProducer: GeneratedProducer | null
    readonly currentProducer: Readonly<{ package: string; version: string; sourceRevision: string }>
    readonly fixContext: FixContext
    readonly repairAuthority?: GeneratedEnvironmentRepairAuthority
    readonly repairRefusal?: RefusalOutcome
    /** Every declared MCP server as rendered; empty when the environment could not be prepared. */
    readonly mcpServers: readonly McpServer[]
}
