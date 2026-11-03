import { prepareTeamMetadata, applyTeamMetadata, type TeamMetadataChange } from '../team-metadata.js'
import { installedPackageMetadata } from '../package-metadata.js'
import { cockpitCommand, initCommand, type FixContext } from '../fix-catalogue.js'
import { proposeGeneratedEnvironmentRepair } from '../repair.js'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
    chmod,
    lstat,
    mkdtemp,
    open,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProxy } from 'node:util/types'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parseDocument } from 'yaml'

import {
    consumeWorkEnvironmentConfigProjection,
    loadCockpitConfig,
    observeConfigSource,
    projectWorkEnvironmentConfig,
    type ConsumedWorkEnvironmentConfig,
} from '../config/load.js'
import { renderBrowserSurfaces } from '../browser/surfaces.js'
import { resolveBrowserRuntime, type BrowserRuntimeProjection } from '../browser/runtime.js'
import { resolveObservationPostures } from './posture-observation.js'
import type { Diagnostic } from '../diagnostics.js'
import { authenticatedExecutionOutcome, executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { deriveRegistry, type DerivedRegistry } from '../registry-derivation.js'
import { SURFACE_FEATURES, SURFACE_TARGETS, type RenderedSurfaceFile, type SurfaceFeature, type SurfaceSourceFile, type SurfaceTarget } from '../surfaces/contract.js'
import { GUARD_SURFACE_TARGETS, harnessFact, isGuardSurfaceTarget, listedSurfaceTargets, SURFACE_PUBLICATION_ANCHORS } from '../surfaces/harness-registry.js'
import { mergeAdoptedSurface } from '../surfaces/adoption.js'
import { generateSurfaceEstate, type SurfaceGenerationOutcome, type SurfaceGenerationWarning } from '../surfaces/generator-adapter.js'
import { mergeSurfaceDeclarations, type ActiveSurfaceOverride, type SurfaceUpgradeFinding } from '../surfaces/merge.js'
import {
    CORE_EVALUATOR_ASSET as EVALUATOR_ASSET,
    CORE_PROCEDURE_ASSETS as PROCEDURE_ASSETS,
    CORE_SKILL_ASSETS as SKILL_ASSETS,
    coreSurfaceDeclarations,
    shippedSkillSources,
} from '../surfaces/core-declarations.js'
import { effectivePolicy } from '../autonomy.js'
import { collectMcpDeclarations, hasTargetMcpServers, mcpApprovalDigest, parseMcpDeclarationFile, type McpCollectionOutcome, type McpDeclaration, type McpDiagnostic } from '../surfaces/mcp.js'
import {
    renderSharedPostimage,
    bindSurfaceOwnershipIdentity,
    classifyGeneratedPaths,
    encodeOwnershipManifest,
    parseOwnershipManifest,
    projectGeneratedPathFacts,
    type GeneratedPathFact,
    type GeneratedPathDeclaration,
    type GeneratedPathClassificationResult,
    type GeneratedProducer,
    type OwnershipEntry,
    type EnvironmentOwnershipEntry,
    type OwnershipManifest,
    type SurfaceDesiredEntry,
    type SurfaceDiagnostic,
    type SurfacePriorOwnedEntry,
} from '../surfaces/ownership.js'
import { codexWritableRoot, observeSiblingGuides, planSiblingProjection, shippedInstructionCapabilities, SIBLING_GUIDE_MARKER, type DirectoryGrant, type GuideObservation, type GuideObservationRequest, type ProjectionPlannerInput, type StandingCost } from '../surfaces/projection.js'
import {
    renderSurfaceSet,
    surfaceModelSha256,
    type CustomSurfaceReceipt,
    type NativeFragmentSet,
    type SurfaceInputEvidence,
} from '../surfaces/render.js'
import { stripDevelopmentMarkers } from '../surfaces/development-markers.js'
import { renderConsumerInstructions } from '../surfaces/consumer-instructions.js'
import { expandRestrictions } from '../surfaces/restrictions.js'
import { GUARD_LOCAL_PATHS, writeCockpitLocalFiles, writeGuardLocalIdentity, type GuardHandlerIdentity } from '../guards/local-identity.js'
import { fileFingerprint, verifiedDigest } from '../environment-exec/verified-digest.js'
import { planSurfaceChanges, type SurfaceChange, type SurfaceObservedEntry, type SurfaceChangePlanResult } from '../surfaces/sync.js'
import { SHIPPED_SETUP_SKILL, extendInspectedSkillStandingCosts, inspectRenderedSkillSet, inspectSkillSet, projectInspectedSkillOutputs, type InspectedBootstrapOutputs, type SkillStandingCost } from '../surfaces/skill-contract.js'
import {
    nodeAuthority,
    readAnchoredFile,
    readAnchoredEntry,
    readAnchoredBatches,
    readPersonaSource,
    expectedState,
    portablePublicationPaths,
    admitPublicationPlan,
    authorizePublicationPlan,
    runPublicationPlan,
    type AnchoredEntry,
    type AnchoredBatchReadResult,
    type PublicationMutation,
    type DirectoryIdentity,
    type PersonaSourceIdentity,
    type GeneratedStaleRemovalApprovalRequest,
    type GeneratedStaleRemovalApproval,
    type PublicationPlan,
} from '../generated-environment/transaction.js'
import { ENVIRONMENT_CODES, errorCause, snapshotEnvironmentObservation, snapshotExecutionStep, snapshotGeneratedJson, type EnvironmentObservation, type ExecutionStep, type CockpitId, RefusalError, tryParseJson, hasErrorCode } from './contract.js'
import { SIBLING_DEFAULT_GUIDES } from '../schema.js'
import type { ResolvedExecutable } from './executable.js'
import { resolveDockerExecutable, resolveExecutablePath, resolveGitExecutable } from './executable.js'
import { checkoutId, cockpitId, publicationCockpitId, stackId } from './identity.js'
import { assessComposeTopology, composeProjectDirectory, observeComposeTopology } from './compose-topology.js'
import { declaredRuntime } from './declaration.js'
import { COMPOSE_OWNERSHIP_FILE, renderComposeOwnership } from './compose-ownership.js'
import { earlierNameRefusalMessage, findStackUnderEarlierName, resolveLifecycleStage } from './lifecycle-stage.js'
import {
    authenticateStatePublication,
    observeConfiguration,
    readState,
    selectBootstrapStateRoot,
    selectStateRoot,
    type BootstrapStateAddress,
    type BootstrapStateRecord,
    type StateNamespace,
    type StateResult,
} from './state.js'
import { TESTING_GUIDE_REGISTRY, createGateRegistry, renderTierGuide, type GateRegistry } from '../testing/gates.js'
import { NATIVE_HOOK_COST_SCRIPT, projectNativeHooks, type NativeHookEntry, type NativeHookPolicy } from '../testing/hooks.js'
import { observeGeneratedCheckoutIdentity, revalidateGeneratedCheckoutIdentity, type GeneratedCheckoutIdentity } from './setup-observation.js'
import { exactKeys } from '../exact-keys.js'
import { refusalOutcome as refuse } from '../refusal.js'

const OWNER = 'generated-environment-application'

export const surfaceObservationDeclarations = Object.freeze([
    { id: 'harness-surfaces', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
    { id: 'directory-grants', owner: OWNER, postures: ['directory-grants'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
    { id: 'guide-budget', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
    { id: 'skill-budget', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
] as const)

const issuedSurfaceObservations = new WeakMap<object, number>()

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
    readonly now?: () => string
    readonly observeSource: typeof observeConfigSource
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    readonly authorizeStaleRemoval?: (
        request: GeneratedStaleRemovalApprovalRequest,
    ) => Promise<GeneratedStaleRemovalApproval | undefined>
}

export type { GeneratedStaleRemovalApprovalEntry, GeneratedStaleRemovalApprovalRequest, GeneratedStaleRemovalApproval } from '../generated-environment/transaction.js'

interface OwnedBytes {
    readonly path: string
    readonly bytes: string
    readonly sha256: string
}

interface PreparedEnvironment {
    readonly root: string
    readonly cockpitId: CockpitId
    readonly stackId: ReturnType<typeof stackId>
    readonly runtimeCheckout?: GeneratedCheckoutIdentity
    readonly configPath: string
    readonly sourceSha256: string
    readonly runtimeSha256: string
    readonly personaSource: Readonly<{ path: string; sha256: string }>
    readonly personaSourceIdentity: PersonaSourceIdentity
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
    readonly nativeHookPolicySource?: Readonly<{ path: string; sha256: string; identity: PersonaSourceIdentity }>
    // The declared Compose files the ownership override was rendered from, re-read before publication.
    readonly composeSources: readonly Readonly<{ path: string; sha256: string; identity: PersonaSourceIdentity }>[]
    readonly surfaceAssets: readonly SurfaceAssetIdentity[]
    readonly warnings: readonly SurfaceGenerationWarning[]
    // Declared MCP servers left out of `[mcp].approved`: rendered disabled, and said so on every sync and check.
    readonly unapprovedMcpServers: readonly Readonly<{ name: string; sources: readonly string[]; sha256: string }>[]
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

function activeClaudeImports(bytes: string): readonly number[] {
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

async function siblingRootsCurrent(authority: AuthenticatedSiblingRoots): Promise<boolean> {
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

async function authenticateSiblingRoots(
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

interface SourceRootIdentity {
    readonly slug: string
    readonly root: string
    readonly identity: DirectoryIdentity
}

interface AdoptedSourceIdentity {
    readonly path: string
    readonly sha256: string
    readonly identity: PersonaSourceIdentity
}

interface CustomSourceIdentity {
    readonly harness: string
    readonly feature: SurfaceFeature
    readonly path: string
    readonly sha256: string
    readonly identity: PersonaSourceIdentity
    readonly maxBytes: number
}

interface SurfaceAssetIdentity {
    readonly path: SurfaceAssetPath
    readonly sha256: string
    readonly identity: PersonaSourceIdentity
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
        readonly identity: PersonaSourceIdentity
        readonly restriction: 'instructed'
    }>
    readonly installedSkills: readonly Readonly<{
        readonly path: string
        readonly sha256: string
    }>[]
    readonly browser?: Readonly<{
        readonly runtime: BrowserRuntimeProjection
        readonly namespace: StateNamespace
        readonly mcp: McpDeclaration
        readonly skillTemplate: Readonly<{
            readonly path: string
            readonly bytes: string
            readonly sha256: string
            readonly identity: PersonaSourceIdentity
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
}

interface GeneratedSurfaceHealthEvidence {
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

interface RefusalOutcome {
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

const defaultAdapters: GeneratedEnvironmentCommandAdapters = { observeSource: observeConfigSource, execute: executeProbe }
const OWNERSHIP_PATH = '.cockpit/generated-environment-ownership.json'
const SHA256 = /^[a-f0-9]{64}$/
const MAX_OWNERSHIP_BYTES = 1_048_576
const COMPOSE_SOURCE_BYTES = 1_048_576
const MAX_OWNED_FILES = 256
const MAX_EXECUTABLE_BYTES = 536_870_912
const MAX_GENERATED_BYTES = 16_777_216
const MAX_SURFACE_FILE_BYTES = 65_536
const MAX_SURFACE_BYTES = 4_194_304
const MAX_HELPER_FRAME_BYTES = 65_536
const HELPER_TIMEOUT_MS = 10_000
// The native hook cost workload spawns Git once per ref update, 128 times. On a loaded host that
// takes seconds (7 s at a load average of 24), so under the helper bound an over-budget hook timed
// out and was reported as a failed execution instead of being sent to CI.
const NATIVE_HOOK_COST_TIMEOUT_MS = 60_000
const SURFACE_ROOT = fileURLToPath(new URL('../../surfaces', import.meta.url))
const RESTRICTION_ASSETS = Object.freeze([
    'guards/bash-guard.sh',
    'guards/claude.adapter.json',
    'guards/codex.adapter.json',
    'guards/opencode.adapter.json',
] as const)
// Shipped beside the setup skill, outside the skill contract: the skill set admits only entry points and the
// shared procedure, and these are pulled on demand like the browser reference.
const REFERENCE_ASSETS = Object.freeze([
    'references/test-data-and-personas.md',
] as const)
const WORK_ASSETS = Object.freeze([
    'skills/cockpit-browser.skill.md',
    'references/browser.md',
    'references/testing-tiers.md',
] as const)
type SurfaceAssetPath = typeof RESTRICTION_ASSETS[number] | typeof EVALUATOR_ASSET | typeof SKILL_ASSETS[number] | typeof REFERENCE_ASSETS[number] | typeof WORK_ASSETS[number]
interface GeneratedApplicationRecord {
    readonly root: string
    readonly stackId: ReturnType<typeof stackId>
    readonly currentPublication: true | false
    readonly siblingRoots: AuthenticatedSiblingRoots
    readonly node: ResolvedExecutable
    readonly workApplication?: WorkApplicationAuthorityRecord
    readonly surfaceSelftest: GeneratedSurfaceSelftestProjection
    readonly surfaceHealth: GeneratedSurfaceHealthEvidence
}

type WorkApplicationAuthorityRecord = ConsumedWorkApplicationAuthorities

const issuedApplicationProjections = new WeakMap<object, GeneratedApplicationRecord>()
const projectedWorkApplicationAuthorities = new WeakSet<object>()
const issuedWorkApplicationAuthorities = new WeakMap<object, WorkApplicationAuthorityRecord>()

interface SelectedBootstrapRecord {
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

const issuedSelectedBootstrapAuthorities = new WeakMap<object, SelectedBootstrapRecord>()
const consumedBootstrapStatePublications = new WeakSet<object>()

function skillDescription(bytes: string): string | undefined {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(bytes)?.[1]
    if (front === undefined) return undefined
    const description = (parseDocument(front).toJS({ maxAliasCount: 0 }) as { description?: unknown } | null)?.description
    return typeof description === 'string' ? description : undefined
}

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function sha256(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex')
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
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

function guideLines(bytes: string): number {
    return bytes.trimEnd().split('\n').length
}

// An overlay pins the digest of the built-in it replaces, so a cockpit upgrade that changes that
// built-in is reviewed before the override keeps shadowing it.
function overrideChanged(finding: SurfaceUpgradeFinding, severity: 'error' | 'warning') {
    return {
        severity, code: 'OVERRIDDEN_CORE_CHANGED' as const satisfies SurfaceUpgradeFinding['code'], target: finding.overlaySource,
        message: `overlay ${finding.name} replaces the built-in ${finding.name} recorded as sha256 ${finding.recordedSha256}, but this cockpit version's built-in is sha256 ${finding.currentSha256}`,
        fix: 'review the new built-in against your override, set the overlay\'s replaces.sha256 to the current digest this message names, then run npx --no cockpit sync --config <your cockpit.toml>',
    }
}

// Copied sibling guides count toward the cap, so a sibling's own edit can push it over.
function guideCapExceeded(cost: Readonly<{ target: string; value: number; cap: number }>): RefusalOutcome {
    return { kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [{
            severity: 'error' as const, code: ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED, target: 'cockpit.guide_cap',
            message: `the instructions ${cost.target} loads at start are ${cost.value} lines, over cockpit.guide_cap ${cost.cap}; the count includes each sibling guide copied into the root AGENTS.md`,
            fix: 'shorten the root or sibling guides, or move conditional guidance into a skill, or raise cockpit.guide_cap in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml>',
        }] }
}

// Codex 0.166.0 dropped the end of a project AGENTS.md past 32 KiB without saying so (measured
// 2026-11-03), and the copied sibling guides sit at the end of cockpit's region. The team's own text
// outside the region counts too, so this is the least the file holds.
const CODEX_PROJECT_DOC_BYTES = 32_768

function guideBytesExceeded(bytes: number): RefusalOutcome {
    return { kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [{
            severity: 'error' as const,
            // A literal, so the diagnostic inventory captures the fix beside the code.
            code: 'GUIDE_CAP_EXCEEDED' as const satisfies typeof ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED,
            target: 'AGENTS.md',
            message: `cockpit's part of the root AGENTS.md, with the sibling guides it copies, is ${bytes} bytes; Codex drops whatever follows the first 32768 bytes of a project AGENTS.md without saying so`,
            fix: 'shorten the root or sibling guides, or name fewer guides in sibling.guides, then run npx --no cockpit sync --config <your cockpit.toml>',
        }] }
}

// The projection skips an absent guide, so a misspelled name otherwise copies nothing and says nothing.
function siblingGuideMissing(slug: string, guide: string, sourcePath: string): RefusalOutcome {
    return { kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [{
            severity: 'error' as const,
            code: 'SIBLING_GUIDE_MISSING' as const satisfies typeof ENVIRONMENT_CODES.SIBLING_GUIDE_MISSING,
            target: `sibling.${slug}.guides`,
            message: `sibling ${slug} declares the guide ${guide}, but ${sourcePath} does not exist, so no harness would load it`,
            fix: 'correct or remove the guide name in that sibling\'s guides list in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml>',
        }] }
}

function overrideChangedRefusal(finding: SurfaceUpgradeFinding): RefusalOutcome {
    return { kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [overrideChanged(finding, 'error')] }
}

function complete(
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
        ...(!dryRun && prepared.workApplication ? { workApplication: prepared.workApplication } : {}),
    }))
    return {
        kind: 'complete', artifact: null, destination: null,
        diagnostics: [
            // A trust warning is a review prompt for settings being written; repeating it for an
            // unchanged file on every sync and check trained people to ignore it.
            ...prepared.warnings.filter(warning => changes.some(change => change.operation === 'write' && change.path === warning.path))
                .map(({ severity, code, target, path, message }) => ({
                    severity, code, target: `${target}:${path}`, message,
                })),
            ...prepared.unapprovedMcpServers.map(server => ({
                severity: 'warning' as const, code: 'MCP_NOT_APPROVED' as const satisfies McpDiagnostic['code'], target: server.name,
                message: `MCP server ${server.name}, declared in ${server.sources.join(', ')}, has no approval in [mcp.approved] for its current command, arguments, working directory and environment names (sha256 ${server.sha256}), so every harness keeps it disabled`,
                fix: 'to enable it, review its declaration, set its name to the sha256 in this message under [mcp.approved] in cockpit.toml and run npx --no cockpit sync --config <your cockpit.toml>; to keep it off, nothing is needed',
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

function generatedPathFacts(prepared: PreparedEnvironment, applicability: 'declared-before-sync' | 'required-after-sync') {
    const manifest = encodeOwnershipManifest(prepared).manifest
    const declarations: GeneratedPathDeclaration[] = [
        ...prepared.generated.map(file => ({ producer: 'generated-environment' as const, applicability,
            entry: manifest.entries.find(entry => entry.path === file.path)! })),
        ...prepared.surfaces.map(file => ({ producer: 'surface-render' as const, applicability,
            entry: manifest.entries.find(entry => entry.path === file.path)! })),
    ]
    return projectGeneratedPathFacts(manifest, { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath }, declarations)
}

export function generatedApplicationProjection(value: unknown): GeneratedApplicationProjection | undefined {
    return value !== null && typeof value === 'object' && issuedApplicationProjections.has(value)
        ? value as GeneratedApplicationProjection : undefined
}

export function projectWorkApplicationAuthorities(
    application: GeneratedApplicationProjection,
): WorkApplicationAuthoritiesProjection | undefined {
    if (application === null || typeof application !== 'object' || projectedWorkApplicationAuthorities.has(application)) return undefined
    const record = issuedApplicationProjections.get(application)
    if (!record?.workApplication) return undefined
    const projection: WorkApplicationAuthoritiesProjection = { kind: 'work-application-authorities' }
    projectedWorkApplicationAuthorities.add(application)
    issuedWorkApplicationAuthorities.set(projection, record.workApplication)
    return projection
}

export function consumeWorkApplicationAuthorities(
    projection: WorkApplicationAuthoritiesProjection,
): ConsumedWorkApplicationAuthorities | undefined {
    if (projection === null || typeof projection !== 'object') return undefined
    const record = issuedWorkApplicationAuthorities.get(projection)
    if (!record) return undefined
    issuedWorkApplicationAuthorities.delete(projection)
    return record
}

export async function prepareWorkApplicationAuthorities(
    input: GeneratedEnvironmentCommandInput,
): Promise<WorkApplicationAuthoritiesProjection | RefusalOutcome> {
    const request = commandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'work application input is invalid', 'work')
    const loaded = await loadCockpitConfig(request.configPath)
    if (loaded.kind !== 'complete') return {
        kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [...loaded.diagnostics],
    }
    const configProjection = projectWorkEnvironmentConfig(loaded.result)
    const workEnvironment = configProjection && consumeWorkEnvironmentConfigProjection(configProjection)
    const node = await nodeAuthority()
    if (!workEnvironment || !node) return refuse('GENERATED_RENDER_UNAUTHENTICATED', 'work configuration or Node authority is unavailable', request.configPath)
    const read = await readAnchoredFile(SURFACE_ROOT, EVALUATOR_ASSET, MAX_SURFACE_FILE_BYTES, node, defaultAdapters)
    const evaluator = readSurfaceAsset(EVALUATOR_ASSET, read)
    if (!evaluator) return refuse('SURFACE_INPUT_INVALID', 'the shipped evaluator could not be authenticated', EVALUATOR_ASSET)
    const projection: WorkApplicationAuthoritiesProjection = { kind: 'work-application-authorities' }
    issuedWorkApplicationAuthorities.set(projection, Object.freeze({
        workEnvironment,
        evaluator: Object.freeze({ path: resolve(SURFACE_ROOT, evaluator.path), bytes: evaluator.bytes,
            sha256: evaluator.sha256, identity: evaluator.identity, restriction: 'instructed' as const }),
        installedSkills: Object.freeze([]),
        testing: Object.freeze({ registry: workEnvironment.testing ? createGateRegistry(workEnvironment.testing.declarations) : TESTING_GUIDE_REGISTRY }),
    }))
    return projection
}

function selectedBootstrapInput(input: unknown): SelectedBootstrapSurfaceInput | undefined {
    const record = ownRecord(input)
    if (!record || !exactKeys(record, ['root', 'target', 'tools']) || typeof record.root !== 'string'
        || !isAbsolute(record.root) || resolve(record.root) !== record.root
        || !SURFACE_TARGETS.includes(record.target as SurfaceTarget)
        || !Array.isArray(record.tools) || record.tools[0] !== record.target
        || new Set(record.tools).size !== record.tools.length
        || record.tools.some(tool => !SURFACE_TARGETS.includes(tool as SurfaceTarget))) return undefined
    return { root: record.root, target: record.target as SurfaceTarget, tools: [...record.tools] as SurfaceTarget[] }
}

type AuthenticatedAsset = Readonly<{ path: string; bytes: string; sha256: string }>

/** The shipped skill sources with the packaged collection and procedures that authenticate them. */
function bootstrapSkillInput(assets: ReadonlyMap<string, AuthenticatedAsset>): Readonly<{
    sources: readonly SurfaceSourceFile[]
    collection: AuthenticatedAsset
    procedures: readonly AuthenticatedAsset[]
}> | undefined {
    const skills = shippedSkillSources(assets)
    const collection = assets.get('skills/collection.json')
    const procedures = PROCEDURE_ASSETS.map(path => assets.get(path))
    if (!skills || !collection || procedures.some(row => row === undefined)) return undefined
    const pick = ({ path, bytes, sha256: digest }: AuthenticatedAsset) => ({ path, bytes, sha256: digest })
    return { sources: skills.flatMap(skill => skill.sources), collection: pick(collection),
        procedures: (procedures as AuthenticatedAsset[]).map(pick) }
}

async function selectedBootstrapAssets(
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<readonly Readonly<{ path: SurfaceAssetPath; bytes: string; sha256: string; identity: PersonaSourceIdentity }>[] | undefined> {
    const reads = await readAnchoredBatches(SURFACE_ROOT, SKILL_ASSETS.map(path => ({
        path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
    })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== SKILL_ASSETS.length) return undefined
    const assets = SKILL_ASSETS.map((path, index) => readSurfaceAsset(path, reads.results[index]!))
    return assets.every((asset): asset is NonNullable<typeof asset> => asset !== undefined) ? assets : undefined
}

async function selectedBootstrapRecordCurrent(record: SelectedBootstrapRecord): Promise<boolean> {
    try {
        const root = await lstat(record.root)
        if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== record.rootIdentity.dev || root.ino !== record.rootIdentity.ino) return false
        const reads = await readAnchoredBatches(SURFACE_ROOT, record.assets.map(asset => ({
            path: asset.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
        })), record.node, record.adapters)
        const state = record.bootstrapState && await readState(record.bootstrapState.address)
        return (!record.bootstrapState || state?.kind === 'complete'
                && JSON.stringify(state.value) === JSON.stringify(record.bootstrapState.record))
            && !!reads && reads.kind === 'complete' && reads.results.length === record.assets.length
            && reads.results.every((read, index) => read.kind === 'complete' && read.sha256 === record.assets[index]!.sha256
                && sourceIdentity(read.identity) === sourceIdentity(record.assets[index]!.identity))
    } catch {
        // a failed re-observation means the inputs are no longer authenticated; the caller refuses.
        return false
    }
}

export async function prepareSelectedBootstrapSurface(
    input: SelectedBootstrapSurfaceInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<SelectedBootstrapSurfaceOutcome> {
    const captured = selectedBootstrapInput(input)
    if (!captured) return refuse('GENERATED_INPUT_INVALID', 'selected bootstrap input is invalid', 'bootstrap')
    const adapters = mergedAdapters(adapterOverrides)
    let root: string
    let rootIdentity: DirectoryIdentity
    try {
        root = await realpath(captured.root)
        const status = await lstat(root)
        if (root !== captured.root || !status.isDirectory() || status.isSymbolicLink()) throw new RefusalError('root')
        rootIdentity = { dev: status.dev, ino: status.ino }
    } catch (error) {
        return refuse('GENERATED_INPUT_INVALID', `selected bootstrap root is not a canonical directory: ${errorCause(error)}`, captured.root)
    }
    const node = await nodeAuthority()
    const assets = node && await selectedBootstrapAssets(node, adapters)
    if (!node || !assets) return refuse('SURFACE_INPUT_INVALID', 'packaged bootstrap assets could not be authenticated', 'bootstrap')
    const skillInput = bootstrapSkillInput(new Map(assets.map(asset => [asset.path, asset])))
    if (!skillInput) return refuse('SURFACE_INPUT_INVALID', 'packaged bootstrap assets are incomplete', 'bootstrap')
    const { sources } = skillInput
    const inspection = await inspectSkillSet(skillInput)
    if (inspection.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'packaged bootstrap skill set was refused', 'bootstrap')
    const inspected = projectInspectedSkillOutputs(inspection, captured.tools, SHIPPED_SETUP_SKILL)
    if (inspected.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'selected bootstrap output set was refused', captured.target)
    const reads = await readAnchoredBatches(root, inspected.files.map(file => ({
        path: file.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-entry' as const,
    })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== inspected.files.length) {
        return refuse('SURFACE_STATE_CONFLICT', 'selected bootstrap destinations could not be authenticated', captured.target)
    }
    const mutations: PublicationMutation[] = []
    for (const [index, file] of inspected.files.entries()) {
        const current = reads.results[index]!
        if (current.kind !== 'missing' && current.kind !== 'file') return refuse('SURFACE_STATE_CONFLICT', 'selected bootstrap destination is not a regular file or missing', file.path)
        if (current.kind === 'file' && current.sha256 !== file.sha256) return refuse('SURFACE_STATE_CONFLICT', 'selected bootstrap destination contains unmanaged bytes', file.path)
        if (current.kind === 'missing') mutations.push({ path: file.path, phase: 'desired', operation: 'write-file',
            bytes: file.bytes, sha256: file.sha256, expected: { kind: 'missing' as const } })
    }
    const admitted = await admitPublicationPlan({ mode: 'bootstrap', root, rootIdentity, node, inspected,
        mutations }, adapters)
    if (admitted.kind !== 'complete') return admitted
    const sourceRows = sources.map(source => ({ path: source.path, sha256: sha256(source.bytes) }))
    const files = inspected.files.map(file => ({ path: file.path, sha256: file.sha256 }))
    const previewSha256 = sha256(JSON.stringify({ target: captured.target, sources: sourceRows, files }))
    const result: SelectedBootstrapSurfaceResult = { root, target: captured.target, sources: sourceRows, files,
        previewSha256, changes: admitted.plan.changes }
    const authority: SelectedBootstrapPublicationAuthority = { kind: 'selected-bootstrap-publication-authority' }
    issuedSelectedBootstrapAuthorities.set(authority, Object.freeze({ root, rootIdentity, target: captured.target, node,
        assets: Object.freeze(assets.map(({ path, sha256: digest, identity }) => ({ path, sha256: digest, identity }))),
        inspected, result, plan: admitted.plan, adapters }))
    return { kind: 'complete', artifact: null, destination: null, diagnostics: [], result, authority, status: 0 }
}

export async function applySelectedBootstrapSurface(
    authority: SelectedBootstrapPublicationAuthority,
): Promise<SelectedBootstrapSurfaceOutcome> {
    const record = authority !== null && typeof authority === 'object' ? issuedSelectedBootstrapAuthorities.get(authority) : undefined
    if (!record) return refuse('GENERATED_PUBLICATION_FAILED', 'selected bootstrap publication authority is unknown or already consumed', 'bootstrap')
    issuedSelectedBootstrapAuthorities.delete(authority)
    const outcome = await runPublicationPlan(record.plan, { execute: record.adapters.execute,
        revalidate: async () => selectedBootstrapRecordCurrent(record) })
    if (outcome.kind !== 'complete') return outcome
    return { kind: 'complete', artifact: null, destination: null, diagnostics: [],
        result: record.result, authority, status: 0 }
}

export async function resumeSelectedBootstrapSurface(
    input: SelectedBootstrapResumeInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<SelectedBootstrapResumeOutcome> {
    const captured = selectedBootstrapInput({ root: input.root, target: input.target, tools: input.tools })
    const durable = await readState(input.address)
    if (!captured || durable.kind !== 'complete' || durable.value.kind !== 'bootstrap'
        || durable.value.value.checkoutRoot !== captured.root || durable.value.target !== captured.target
        || input.address.checkoutRoot !== captured.root || input.address.target !== captured.target
        || durable.value.value.stage === 'surface-previewed') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap resume requires the current durable state, root and target', 'bootstrap',
    )
    const adapters = mergedAdapters(adapterOverrides)
    let rootIdentity: DirectoryIdentity
    try {
        const status = await lstat(captured.root)
        if (!status.isDirectory() || status.isSymbolicLink() || await realpath(captured.root) !== captured.root) throw new RefusalError('root')
        rootIdentity = { dev: status.dev, ino: status.ino }
    } catch (error) {
        return refuse('GENERATED_INPUT_INVALID', `selected bootstrap root is not a canonical directory: ${errorCause(error)}`, captured.root)
    }
    const node = await nodeAuthority()
    if (!node) return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume could not authenticate the node executable', 'bootstrap')
    const ownership = await readAnchoredEntry(captured.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, node, adapters)
    if (ownership.kind !== 'missing' && ownership.kind !== 'file') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap resume ownership could not be read safely', OWNERSHIP_PATH,
    )
    const assets = await selectedBootstrapAssets(node, adapters)
    if (!assets) return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume packaged assets could not be authenticated', 'bootstrap')
    const skillInput = bootstrapSkillInput(new Map(assets.map(asset => [asset.path, asset])))
    if (!skillInput) return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume packaged assets are incomplete', 'bootstrap')
    const { sources } = skillInput
    const inspection = await inspectSkillSet(skillInput)
    if (inspection.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume skill set was refused', 'bootstrap')
    const inspected = projectInspectedSkillOutputs(inspection, captured.tools, SHIPPED_SETUP_SKILL)
    if (inspected.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume output projection was refused', captured.target)
    const sourceRows = sources.map(source => ({ path: source.path, sha256: sha256(source.bytes) }))
    const files = inspected.files.map(file => ({ path: file.path, sha256: file.sha256 }))
    const previewSha256 = sha256(JSON.stringify({ target: captured.target, sources: sourceRows, files }))
    const state = durable.value.value
    const sourcesCurrent = JSON.stringify(state.sources) === JSON.stringify(sourceRows)
        && JSON.stringify(state.published) === JSON.stringify(files) && state.previewSha256 === previewSha256
    if (ownership.kind === 'missing') {
        if (sourcesCurrent) return { kind: 'pending', status: 0, diagnostics: [],
            result: null, canonicalOwnership: false }
        const priorPreviewSha256 = sha256(JSON.stringify({ target: captured.target, sources: state.sources, files: state.published }))
        if (input.expectedRevision !== durable.value.revision || input.expectedCommandSha256 !== state.commandSha256
            || priorPreviewSha256 !== state.previewSha256 || state.stage !== 'surface-published'
            || JSON.stringify(state.published.map(row => row.path)) !== JSON.stringify(files.map(row => row.path))) return refuse(
            'GENERATED_SOURCE_CHANGED', 'bootstrap resume package sources differ from the accepted durable preview', 'bootstrap',
        )
        const reads = await readAnchoredBatches(captured.root, inspected.files.map(file => ({
            path: file.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-entry' as const,
        })), node, adapters)
        if (!reads || reads.kind !== 'complete' || reads.results.length !== inspected.files.length) return refuse(
            'SURFACE_STATE_CONFLICT', 'bootstrap refresh destinations could not be authenticated', captured.target,
        )
        const mutations: PublicationMutation[] = []
        for (const [index, file] of inspected.files.entries()) {
            const current = reads.results[index]!
            const prior = state.published[index]!
            if (current.kind !== 'file' || current.sha256 !== prior.sha256 && current.sha256 !== file.sha256) return refuse(
                'SURFACE_STATE_CONFLICT', 'bootstrap refresh destination differs from its authenticated publication', file.path,
            )
            if (current.sha256 === file.sha256) continue
            const expected = expectedState(current)
            if (!expected) return refuse('SURFACE_STATE_CONFLICT', 'bootstrap refresh destination could not be authenticated', file.path)
            mutations.push({ path: file.path, phase: 'desired', operation: 'write-file',
                bytes: file.bytes, sha256: file.sha256, expected })
        }
        const admitted = await admitPublicationPlan({ mode: 'bootstrap', root: captured.root, rootIdentity, node, inspected,
            mutations, refresh: { address: input.address,
                revision: durable.value.revision, commandSha256: state.commandSha256 } }, adapters)
        if (admitted.kind !== 'complete') return admitted
        const result: SelectedBootstrapSurfaceResult = { root: captured.root, target: captured.target,
            sources: sourceRows, files, previewSha256, changes: admitted.plan.changes }
        const authority: SelectedBootstrapPublicationAuthority = { kind: 'selected-bootstrap-publication-authority' }
        issuedSelectedBootstrapAuthorities.set(authority, Object.freeze({ root: captured.root, rootIdentity,
            target: captured.target, node,
            assets: Object.freeze(assets.map(({ path, sha256: digest, identity }) => ({ path, sha256: digest, identity }))),
            inspected, result, plan: admitted.plan, adapters,
            bootstrapState: Object.freeze({ address: input.address, record: durable.value }),
        }))
        return { kind: 'refresh', status: 0, diagnostics: [], result, authority,
            canonicalOwnership: false }
    }
    if (ownership.kind !== 'file') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap resume ownership changed after classification', OWNERSHIP_PATH,
    )
    if (!sourcesCurrent) return refuse(
        'GENERATED_SOURCE_CHANGED', 'bootstrap resume package sources differ from the accepted durable preview', 'bootstrap',
    )
    const base = await prepare({ configPath: join(captured.root, 'cockpit.toml') }, adapters)
    if ('status' in base) return base
    const canonical = await readOwnership(base, adapters)
    if (base.root !== captured.root || canonical.kind !== 'complete'
        || canonical.manifest.format !== 'cockpit-generated-ownership/v3' || canonical.sha256 !== ownership.sha256) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap resume requires canonical ownership bound to the current checkout and configuration', OWNERSHIP_PATH,
    )
    const current = await readAnchoredEntry(captured.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, node, adapters)
    const refreshed = await readState(input.address)
    if (current.kind !== 'file' || current.sha256 !== ownership.sha256
        || sourceIdentity(current.identity) !== sourceIdentity(ownership.identity)
        || refreshed.kind !== 'complete' || JSON.stringify(refreshed.value) !== JSON.stringify(durable.value)) return refuse(
        'GENERATED_SOURCE_CHANGED', 'bootstrap resume ownership or state changed during checking', 'bootstrap',
    )
    return { kind: 'complete', status: 0, diagnostics: [], canonicalOwnership: true,
        result: { root: captured.root, target: captured.target, sources: sourceRows, files, previewSha256,
            changes: [] } }
}

async function authenticatedBootstrapPriorSurfaces(
    root: string,
    state: NonNullable<GeneratedEnvironmentSyncInput['bootstrapState']>,
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<readonly SurfacePriorOwnedEntry[] | undefined> {
    const publication = state.publication
    if (publication === null || typeof publication !== 'object' || consumedBootstrapStatePublications.has(publication)) return undefined
    const authenticated = authenticateStatePublication(state)
    if (!authenticated || authenticated.status !== 'complete' || authenticated.record.kind !== 'bootstrap') return undefined
    const record = authenticated.record
    if (record.target !== state.address.target || state.address.checkoutRoot !== root) return undefined
    const surfaces = await bootstrapPublishedSurfaces(root, record, node, adapters)
    if (surfaces) consumedBootstrapStatePublications.add(publication)
    return surfaces
}

// A plain sync between an interrupted init and its rerun met init's own setup skill files with no
// ownership record and refused them, and its remedy had an agent delete them. The bootstrap record
// sync reads here comes from this user's private state root, scoped to this cockpit root, and the
// files must still hold exactly the bytes init published from the installed package.
async function unfinishedInitSurfaces(
    root: string,
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<UnfinishedInit | undefined> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined
    for (const target of SURFACE_TARGETS) {
        const namespace = await selectBootstrapStateRoot({ platform: process.platform, home: process.env.HOME,
            xdgStateHome: process.env.XDG_STATE_HOME, checkoutRoot: root, target })
        if (namespace.kind !== 'complete') return undefined
        const read = await readState(namespace.value.paths.bootstrap(target))
        if (read.kind === 'complete') return { root, target, published: read.value.value.published.map(row => row.path),
            surfaces: await bootstrapPublishedSurfaces(root, read.value, node, adapters) }
    }
    return undefined
}

interface UnfinishedInit {
    readonly root: string
    readonly target: SurfaceTarget
    readonly published: readonly string[]
    /** Absent when the files no longer hold what init recorded, so sync cannot take them over. */
    readonly surfaces: readonly SurfacePriorOwnedEntry[] | undefined
}

async function bootstrapPublishedSurfaces(
    root: string,
    record: BootstrapStateRecord,
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<readonly SurfacePriorOwnedEntry[] | undefined> {
    if (record.kind !== 'bootstrap' || record.value.stage === 'surface-previewed' || record.value.checkoutRoot !== root
        || record.value.target !== record.target) return undefined
    const assets = await selectedBootstrapAssets(node, adapters)
    if (!assets) return undefined
    const skillInput = bootstrapSkillInput(new Map(assets.map(asset => [asset.path, asset])))
    if (!skillInput) return undefined
    const sourceRows = skillInput.sources.map(source => ({ path: source.path, sha256: sha256(source.bytes) }))
    if (JSON.stringify(sourceRows) !== JSON.stringify(record.value.sources)) return undefined
    const inspection = await inspectSkillSet(skillInput)
    if (inspection.kind !== 'complete') return undefined
    // The record names no tools, so the targets are the ones whose setup skill it published.
    const publishedPaths = new Set(record.value.published.map(row => row.path))
    const inspected = projectInspectedSkillOutputs(inspection, SURFACE_TARGETS, SHIPPED_SETUP_SKILL)
    if (inspected.kind !== 'complete') return undefined
    const files = inspected.files.filter(file => publishedPaths.has(file.path))
    const published = files.map(file => ({ path: file.path, sha256: file.sha256 }))
    if (JSON.stringify(published) !== JSON.stringify(record.value.published)) return undefined
    const reads = await readAnchoredBatches(root, files.map(file => ({
        path: file.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-entry' as const,
    })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== files.length
        || reads.results.some((read, index) => read.kind !== 'file' || read.sha256 !== files[index]!.sha256)) return undefined
    return files.map(file => ({
        kind: 'file' as const, path: file.path, harnesses: [file.target] as [SurfaceTarget], scope: 'always' as const,
        capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const,
        ownership: 'whole-file' as const, sha256: file.sha256,
    }))
}

export function observeGeneratedApplicationSurfaces(
    application: GeneratedApplicationProjection,
): readonly EnvironmentObservation[] | undefined {
    const record = application !== null && typeof application === 'object'
        ? issuedApplicationProjections.get(application)
        : undefined
    if (!record?.currentPublication || record.surfaceSelftest !== application.surfaceSelftest) return undefined
    const grantsSha256 = surfaceModelSha256(record.surfaceHealth.grants)
    const availableGuideCosts = record.surfaceHealth.guideCosts.filter(
        (cost): cost is Exclude<StandingCost, { status: 'unavailable' }> => cost.status !== 'unavailable',
    )
    if (!grantsSha256 || grantsSha256 !== record.surfaceHealth.nativeGrants.modelSha256
        || availableGuideCosts.length !== record.surfaceHealth.guideCosts.length
        || availableGuideCosts.some(cost => cost.status !== 'within_cap')) return undefined
    const guideValue = availableGuideCosts.reduce((maximum, cost) => Math.max(maximum, cost.value), 0)
    const guideCap = availableGuideCosts[0]?.cap
    if (guideCap === undefined || availableGuideCosts.some(cost => cost.cap !== guideCap)) return undefined
    const observedAt = record.surfaceHealth.observedAt
    const required = (posture: string) => ({ state: 'required' as const, posture })
    const observations = [
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE, owner: OWNER, stackId: record.stackId,
            source: `surface-manifest:${record.surfaceSelftest.manifestSha256}`,
            observed: { state: 'available', value: { manifestSha256: record.surfaceSelftest.manifestSha256,
                harnesses: record.surfaceSelftest.configuredHarnesses, entries: record.surfaceSelftest.entries.length }, observedAt },
            expectation: { kind: 'present' }, applicability: required('environment'), freshness: { state: 'current' },
            remedy: 'run npx --no cockpit sync --config <your cockpit.toml>, then rerun npx --no cockpit preflight --config <your cockpit.toml>',
        }),
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE, owner: OWNER, stackId: record.stackId,
            source: `directory-grants:${grantsSha256}`,
            observed: { state: 'available', value: { grants: record.surfaceHealth.grants.length,
                generatedFragments: record.surfaceHealth.nativeGrants.fragments.length, modelSha256: grantsSha256 }, observedAt },
            expectation: { kind: 'present' }, applicability: record.surfaceHealth.grants.length > 0
                ? required('directory-grants')
                : { state: 'not-applicable', posture: 'directory-grants', reason: 'the active sibling projection declares no directory grants' },
            freshness: { state: 'current' },
            remedy: 'run npx --no cockpit sync --config <your cockpit.toml>, then rerun npx --no cockpit preflight --config <your cockpit.toml>',
        }),
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED, owner: OWNER, stackId: record.stackId,
            source: `surface-guide-costs:${record.surfaceSelftest.manifestSha256}`,
            observed: { state: 'available', value: guideValue, observedAt }, expectation: { kind: 'maximum', value: guideCap },
            applicability: required('environment'), freshness: { state: 'current' },
            remedy: 'move conditional guidance behind its scoped or pull-loaded surface, then run npx --no cockpit sync --config <your cockpit.toml>',
        }),
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE, owner: OWNER, stackId: record.stackId,
            source: `installed-skill-inventory:${record.surfaceHealth.skillInventorySha256}`,
            observed: { state: 'available', value: { coreCollectionSha256: record.surfaceHealth.skillCollectionSha256,
                inventorySha256: record.surfaceHealth.skillInventorySha256, inventory: record.surfaceHealth.skillInventory, skills: record.surfaceHealth.skills,
                costs: record.surfaceHealth.skillCosts.map(({ target, metric, value, cap }) => ({ target, metric, value, cap })) }, observedAt },
            expectation: { kind: 'present' }, applicability: required('environment'), freshness: { state: 'current' },
            remedy: 'move skill procedure text out of always-loaded entry points, then run npx --no cockpit sync --config <your cockpit.toml>',
        }),
    ]
    if (!observations.every((observation): observation is EnvironmentObservation => observation !== undefined)) return undefined
    const issuedAt = Date.now()
    for (const observation of observations) issuedSurfaceObservations.set(observation, issuedAt)
    return observations
}

function isGeneratedApplicationSurfaceObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedSurfaceObservations.has(value)
}

function generatedApplicationSurfaceObservationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedSurfaceObservations.get(value) : undefined
}

function commandInput(input: unknown): GeneratedEnvironmentCommandInput | undefined {
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.some((key) => typeof key !== 'string' || key !== 'configPath')
            || !Object.hasOwn(descriptors, 'configPath') || !('value' in descriptors.configPath!)) return undefined
        const configPath = descriptors.configPath.value
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')) return undefined
        return { configPath }
    } catch {
        // a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses.
        return undefined
    }
}

function syncCommandInput(input: unknown): GeneratedEnvironmentSyncInput | undefined {
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.some((key) => typeof key !== 'string' || key !== 'configPath' && key !== 'dryRun' && key !== 'bootstrapState')
            || !Object.hasOwn(descriptors, 'configPath') || !('value' in descriptors.configPath!)) return undefined
        const configPath = descriptors.configPath.value
        const dryRun = Object.hasOwn(descriptors, 'dryRun') && 'value' in descriptors.dryRun! ? descriptors.dryRun.value : false
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0') || typeof dryRun !== 'boolean') return undefined
        const bootstrapState = Object.hasOwn(descriptors, 'bootstrapState') && 'value' in descriptors.bootstrapState!
            ? descriptors.bootstrapState.value : undefined
        if (bootstrapState !== undefined) {
            const state = ownRecord(bootstrapState)
            if (!state || !exactKeys(state, ['publication', 'address'])) return undefined
        }
        return { configPath, dryRun, ...(bootstrapState === undefined ? {} : { bootstrapState }) }
    } catch {
        // a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses.
        return undefined
    }
}

function confined(root: string, path: string): string | undefined {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) return undefined
    const target = resolve(root, path)
    const offset = relative(root, target)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset) ? target : undefined
}

async function safePath(root: string, path: string, allowMissing: boolean): Promise<string | undefined> {
    const target = confined(root, path)
    if (!target) return undefined
    const parts = relative(root, target).split(sep)
    let current = root
    for (const [index, part] of parts.entries()) {
        current = resolve(current, part)
        try {
            const entry = await lstat(current)
            if (entry.isSymbolicLink() || index < parts.length - 1 && !entry.isDirectory()
                || index === parts.length - 1 && !entry.isFile()) return undefined
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) return undefined
            if (!allowMissing && index === parts.length - 1) return undefined
        }
    }
    return target
}

type OwnershipState = { readonly kind: 'missing' }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'unsupported'; readonly format: string }
    | { readonly kind: 'complete'; readonly manifest: OwnershipManifest; readonly bytes: string; readonly sha256: string; readonly identity: PersonaSourceIdentity }

async function readOwnership(
    prepared: PreparedEnvironment,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<OwnershipState> {
    const read = await readAnchoredFile(prepared.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, prepared.node, adapters)
    if (read.kind === 'missing') return { kind: 'missing' }
    if (read.kind !== 'complete') return { kind: 'invalid' }
    try {
        const bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
        const parsed = parseOwnershipManifest(bytes, { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath })
        return parsed.kind === 'complete' ? { kind: 'complete', manifest: parsed.manifest, bytes, sha256: read.sha256, identity: read.identity } : parsed
    } catch {
        // invalid ownership bytes are reported as invalid.
        return { kind: 'invalid' }
    }
}

async function expectedOutputExists(prepared: PreparedEnvironment): Promise<boolean> {
    for (const file of prepared.owned) {
        if (await safePath(prepared.root, file.path, false)) return true
    }
    return false
}

// A ledger recorded under another name means `cockpit.name` was renamed. Publishing under the new
// name is safe for the files, but a stack still recorded under the old one would be left where
// down cannot reach it, so the rename waits until that stack is down.
async function renamedStackRefusal(prepared: PreparedEnvironment): Promise<RefusalOutcome | undefined> {
    const checkout = prepared.runtimeCheckout
    if (!checkout || process.platform !== 'darwin' && process.platform !== 'linux') return undefined
    const namespace = await selectStateRoot({ platform: process.platform, home: process.env.HOME,
        xdgStateHome: process.env.XDG_STATE_HOME,
        checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath], cockpitId: checkout.cockpitId })
    if (namespace.kind !== 'complete') return refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
        `cannot tell whether a stack started before cockpit.name was renamed is still recorded: ${'message' in namespace ? namespace.message : 'the state root is missing'}; nothing was written`, prepared.configPath)
    const earlier = await findStackUnderEarlierName({ namespace: namespace.value, cockpitId: checkout.cockpitId, checkoutId: checkout.checkoutId })
    if (earlier.kind === 'refusal') return refuse(earlier.code, `${earlier.message}; nothing was written`, earlier.target)
    return earlier.name === undefined ? undefined
        : refuse(ENVIRONMENT_CODES.STACK_RECORDED_UNDER_EARLIER_NAME, earlierNameRefusalMessage(prepared.configPath, earlier.name), prepared.configPath)
}

async function prepare(input: unknown, adapters: GeneratedEnvironmentCommandAdapters): Promise<PreparedEnvironment | RefusalOutcome> {
    const request = commandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const loaded = await loadCockpitConfig(request.configPath)
    if (loaded.kind !== 'complete') return {
        kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [...loaded.diagnostics],
    }
    const workProjection = projectWorkEnvironmentConfig(loaded.result)
    const workEnvironment = workProjection && consumeWorkEnvironmentConfigProjection(workProjection)
    if (!workEnvironment || workEnvironment.source.path !== loaded.result.source.path
        || workEnvironment.source.sha256 !== loaded.result.source.sha256) {
        return refuse('GENERATED_RENDER_UNAUTHENTICATED', 'the work environment configuration could not be consumed', loaded.result.source.path)
    }
    const derived = deriveRegistry(loaded.result.config)
    if (derived.kind !== 'complete') return refuse(derived.code, derived.message, loaded.result.source.path)
    const config = derived.result.config
    // A remote runner was a service cockpit rendered into its own Compose file, which it no longer
    // writes; refusing here keeps browser.endpoint from reading as a runner that exists.
    if (workEnvironment.browser && Object.hasOwn(workEnvironment.browser, 'endpoint')) return refuse(
        'GENERATED_DECLARATION_MISSING',
        'browser.endpoint names a remote browser runner, and cockpit renders no runner service',
        'browser',
        'remove browser.endpoint to drive a local browser, then run npx --no cockpit sync --config <your cockpit.toml>',
    )
    const root = dirname(loaded.result.source.path)
    const authenticatedSiblings = await authenticateSiblingRoots(root, derived.result.config, loaded.result.source.path)
    if (authenticatedSiblings.kind === 'refusal') return refuse(
        authenticatedSiblings.code ?? 'GENERATED_SIBLING_ROOT_INVALID',
        authenticatedSiblings.reason,
        authenticatedSiblings.target ?? 'sibling',
        authenticatedSiblings.fix,
    )
    const siblingRoots = authenticatedSiblings.roots
    const runtimeCheckout = workEnvironment.browser || config.environment.compose_files.length > 0
        ? await observeGeneratedCheckoutIdentity({ source: loaded.result.source, cockpitName: config.cockpit.name,
            env: process.env }) : undefined
    if (runtimeCheckout?.state === 'failed') return refuse('GENERATED_INPUT_INVALID',
        `generated checkout identity is unavailable: ${runtimeCheckout.reason}`, loaded.result.source.path,
        'restore the configuration checkout and Git installation, then run npx --no cockpit sync --config <your cockpit.toml>')
    const currentCockpit = runtimeCheckout?.cockpitId ?? cockpitId({ name: config.cockpit.name, mainCheckoutPath: root })
    const publishedCockpit = publicationCockpitId({ name: config.cockpit.name })
    const currentCheckout = runtimeCheckout?.checkoutId ?? checkoutId({ checkoutPath: root })
    const currentStack = stackId({ cockpitId: currentCockpit, checkoutId: currentCheckout, variant: { kind: 'shared' } })
    // Derived from the runtime declarations, not the file bytes, so rewording a purpose or a guard
    // keeps the running stack's identity.
    const generation = sha256(`generated-environment\0${loaded.result.runtimeSha256}`)
    const node = await nodeAuthority()
    if (!node) return refuse(
        'GENERATED_EXECUTABLE_UNAVAILABLE',
        'the current Node executable could not be authenticated',
        process.execPath,
    )
    let composeOwnership: OwnedBytes | undefined
    const composeSources: PreparedEnvironment['composeSources'][number][] = []
    if (config.environment.compose_files.length > 0) {
        const sources = []
        for (const reference of config.environment.compose_files) {
            const read = await readAnchoredFile(root, reference, COMPOSE_SOURCE_BYTES, node, adapters)
            if (read.kind !== 'complete') return refuse('GENERATED_PATH_UNSAFE',
                'a declared Compose file is missing, unreadable, or crosses a symbolic-link boundary', reference)
            sources.push({ reference, source: read.bytes.toString('utf8') })
            composeSources.push({ path: reference, sha256: read.sha256, identity: read.identity })
        }
        const ownership = renderComposeOwnership({ sources, stackId: currentStack, cockpitId: currentCockpit,
            configSha256: loaded.result.runtimeSha256, resettableVolumes: config.environment.resettable_volumes })
        if (ownership.kind !== 'complete') return refuse('GENERATED_DECLARATION_INVALID',
            `the ownership override cannot be rendered from environment.compose_files: ${ownership.reason}`, ownership.target)
        composeOwnership = { path: COMPOSE_OWNERSHIP_FILE, bytes: ownership.bytes, sha256: sha256(ownership.bytes) }
    }
    const generated = composeOwnership ? [composeOwnership] : []
    // The anchored read of the configuration file pins the publication root's identity for the whole sync.
    const sourcePath = relative(root, loaded.result.source.path)
    const sourceTarget = await safePath(root, sourcePath, false)
    if (!sourceTarget) return refuse(
        'GENERATED_PERSONA_SOURCE_UNAVAILABLE',
        'the declared persona source is missing or crosses a symbolic-link boundary',
        sourcePath,
    )
    const source = await readPersonaSource(root, sourcePath, node, adapters)
    if (!source) {
        return refuse('GENERATED_PERSONA_SOURCE_UNAVAILABLE', 'the declared persona source is unreadable', sourcePath)
    }
    const owned = [...generated].sort((left, right) => compareCodeUnits(left.path, right.path))
    if (new Set(owned.map(({ path }) => path)).size !== owned.length
        || owned.some(({ path }) => path === OWNERSHIP_PATH)
        || owned.some(({ path }) => [loaded.result.source.path, sourceTarget].includes(resolve(root, path)))) {
        return refuse('GENERATED_PATH_DUPLICATE', 'generated ownership contains a duplicate or input path', 'generated-environment')
    }
    for (const file of owned) {
        if (!await safePath(root, file.path, true)) {
            return refuse('GENERATED_PATH_UNSAFE', 'generated destination crosses an existing symbolic-link or non-directory boundary', file.path)
        }
    }
    const producedAt = (adapters.now ?? (() => new Date().toISOString()))()
    const now = producedAt.slice(0, 10)
    return {
        root,
        cockpitId: publishedCockpit,
        stackId: currentStack,
        ...(runtimeCheckout ? { runtimeCheckout } : {}),
        configPath: loaded.result.source.path,
        sourceSha256: loaded.result.source.sha256,
        runtimeSha256: loaded.result.runtimeSha256,
        personaSource: { path: sourcePath, sha256: source.sha256 },
        personaSourceIdentity: source.identity,
        generation,
        generated,
        owned,
        surfaces: [],
        compactSurfacePaths: new Set<string>(),
        configuredHarnesses: [...SURFACE_TARGETS],
        activeSurfaceOverrides: [],
        changedOverrideOriginals: [],
        composeSources,
        guideSources: { requests: [], observations: [], missing: [] },
        openCodeGrantRoots: [],
        sourceEvidence: [],
        sourceRoots: [],
        customSources: [],
        adoptedSources: [],
        surfaceAssets: [],
        warnings: [],
        unapprovedMcpServers: [],
        registry: derived.result,
        siblingRoots,
        workEnvironment,
        node,
        now,
        producedAt,
    }
}

function expectedSurfaceOutputs(
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

function expectedClaudePluginOutputs(
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

function claudePluginManifest(): Readonly<{ bytes: string; sha256: string }> {
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
function alwaysLoadedRule(bytes: string): Readonly<{ kind: 'complete'; bytes: string }> | Readonly<{ kind: 'refusal'; reason: string }> {
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

function emptyGeneration(): Extract<SurfaceGenerationOutcome, { kind: 'complete' }> {
    return {
        kind: 'complete', status: 0, diagnostics: [] as readonly [],
        mechanism: { package: 'rulesync', version: '43.1.2', role: 'spelling' },
        files: [],
    }
}

function sourceIdentity(identity: PersonaSourceIdentity): string {
    return JSON.stringify({ root: identity.root, chain: identity.chain, file: identity.file })
}

function readSurfaceAsset(
    path: SurfaceAssetPath,
    read: AnchoredBatchReadResult,
): Readonly<{ path: SurfaceAssetPath; bytes: string; sha256: string; identity: PersonaSourceIdentity }> | undefined {
    if (read.kind !== 'complete') return undefined
    try {
        return { path, bytes: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes),
            sha256: read.sha256, identity: read.identity }
    } catch { /* undecodable bytes are malformed input the caller refuses. */ return undefined }
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
 */
function claudeReadDenials(
    siblings: readonly { slug: string; path: string }[],
    instances: readonly { slug: string; path: string }[],
): readonly string[] {
    const literal = (path: string) => path.replace(/[*?[\]\\!#()]/g, '?')
    const rules = ['//**/.secrets/**', ...instanceReadPaths(siblings, instances)
        .map(row => row.inRoot ? `/${literal(row.path)}` : `//**/${literal(row.path)}`)]
    return [...new Set(rules)].sort(compareCodeUnits)
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
function openCodeReadDenials(
    siblings: readonly { slug: string; path: string }[],
    instances: readonly { slug: string; path: string }[],
): readonly string[] {
    const literal = (path: string) => path.replace(/[*?]/g, '?')
    const paths = ['.secrets/*', ...instanceReadPaths(siblings, instances).map(row => literal(row.path))]
    return [...new Set(paths.flatMap(path => [path, `*/${path}`]))].sort(compareCodeUnits)
}

/** The machine-local file `sync` writes with a sibling's absolute directory, for OpenCode to read. */
function openCodeGrantFile(slug: string): string {
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
// a person's (`init`, `sibling add`) and the destructive `down` are left out so they keep asking. Measured with Claude Code 2.1.316 on 2026-11-02 beside an unruled control: `Bash(<prefix> *)`
// ran a matching command headless, the control and a chain with an unmatched part were denied, a hook
// `ask` denied a matching command, and Claude ignores these rules until a person trusts the workspace.
const AGENT_COCKPIT_COMMANDS = [
    'check *', 'doctor *', 'preflight *', 'logs *', 'sync *', 'reset * --apply', 'up *', 'sleep *', 'runtime measure *', 'test-run *',
    'work status *', 'work accept *', 'work check *', 'work note *', 'work answer *', 'work grade *', 'work signoff *', 'work recover *',
    'work verify *', 'grade *', 'upgrade *',
    'browser drive *', 'browser screenshot *',
] as const

function claudeCommandAllowances(): Readonly<Record<string, 'allow'>> {
    return Object.fromEntries(['npx --no cockpit', './node_modules/.bin/cockpit']
        .flatMap(launcher => AGENT_COCKPIT_COMMANDS.map(command => [`${launcher} ${command}`, 'allow' as const])))
}

// What each harness loads at start, from the dated instruction-loading runs. Claude Code applies a
// scoped rule only to matching files, so a scoped source counts separately there.
const GUIDE_LOAD_CHARACTERIZATIONS = Object.freeze(Object.fromEntries(shippedInstructionCapabilities()
    .filter(fact => isGuardSurfaceTarget(fact.target))
    .map(fact => [fact.target, {
        measuredOn: fact.characterizedOn, metric: 'lines' as const, scopeSemantics: fact.target === 'claudecode' ? 'conditional' as const : 'full' as const,
        provenance: fact.provenance,
    }])))

function nativeSources(
    mcp: Extract<McpCollectionOutcome, { kind: 'complete' }>,
    grants: readonly { slug: string; target: SurfaceTarget; path: string }[],
    siblings: readonly { slug: string; path: string }[],
    instances: readonly { slug: string; path: string }[],
): readonly SurfaceSourceFile[] {
    const sources: SurfaceSourceFile[] = []
    if (mcp.result.servers.length > 0) {
        const transports = mcp.result.harnesses.flatMap(row => row.servers)
        const servers = Object.fromEntries(mcp.result.servers.map(model => transports.find(server => server.name === model.name)!).map(server => [server.name, {
            type: 'stdio', command: server.command, args: server.args, disabled: !server.enabled,
        }]))
        const targets = Object.fromEntries(mcp.result.harnesses.flatMap(row => {
            const removed = mcp.result.servers.filter(server => !row.servers.some(transport => transport.name === server.name))
            return removed.length ? [[harnessFact(row.target).rulesyncTarget, {
                mcpServers: Object.fromEntries(removed.map(server => [server.name, null])),
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
                read: Object.fromEntries(claudeReadDenials(siblings, instances).map(rule => [rule, 'deny'])),
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

function nativeFragmentSet(
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

function nativeGrantFragmentSet(
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
        // OpenCode writes `$schema` into a project config that lacks it at every start, which put an
        // unowned member before the owned region; supplying OpenCode's exact value leaves it untouched.
        const bytes = `${JSON.stringify({ $schema: OPENCODE_CONFIG_SCHEMA, ...base, permission: { external_directory: externalDirectory, read } }, null, 2)}\n`
        return { target: target as SurfaceTarget, path, baseSha256: row?.sha256 ?? sha256(''), bytes, sha256: sha256(bytes) }
    })
    if (fragments.some(fragment => fragment === undefined)) return undefined
    return { modelSha256, fragments: fragments as NonNullable<typeof fragments[number]>[] }
}

function bindNativeGrantsToMcp(
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

function nativeMcpPaths(targets: readonly SurfaceTarget[]): Readonly<Partial<Record<SurfaceTarget, string>>> {
    return Object.fromEntries(targets.map(target => [target, harnessFact(target).outputs.mcp]))
}

function nativeGrantPaths(targets: readonly SurfaceTarget[]): Readonly<Partial<Record<SurfaceTarget, string>>> {
    return Object.fromEntries(targets.map(target => [target, harnessFact(target).outputs.permissions[0]]))
}

// The worker runs in its own process and cannot import modules; `safe` mirrors safeSurfacePath in
// surfaces/contract.ts, including its case-folded reserved segments.
const CUSTOM_SURFACE_WORKER = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const request = JSON.parse(process.argv[1]);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const own = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const safe = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..' && !['.GIT','NODE_MODULES'].includes(part.normalize('NFC').toUpperCase()));
(async () => {
  const source = fs.readFileSync(process.argv[2]);
  if (digest(source) !== request.sourceSha256) throw new RefusalError('module changed');
  const imported = await import('data:text/javascript;base64,' + source.toString('base64'));
  const fn = imported[request.export]; if (typeof fn !== 'function') throw new RefusalError('export');
  const result = await fn(request.input);
  if (!own(result) || Object.keys(result).sort().join(',') !== 'files,kind' || result.kind !== 'complete' || !Array.isArray(result.files) || result.files.length === 0 || result.files.length > 256) throw new RefusalError('result');
  let total = 0; let spelling = false; const files = [];
  for (const [index, file] of result.files.entries()) {
    if (!own(file) || Object.keys(file).sort().join(',') !== 'bytes,path,scope,sha256' || !safe(file.path) || typeof file.bytes !== 'string' || Buffer.byteLength(file.bytes) > 65536 || digest(file.bytes) !== file.sha256 || !['always','scoped'].includes(file.scope)) throw new RefusalError('file');
    spelling = spelling || file.path === request.spelling || file.bytes.includes(request.spelling);
    total += Buffer.byteLength(file.bytes); if (total > 4194304) throw new RefusalError('limit');
    const output = path.join(request.output, String(index)); fs.writeFileSync(output, file.bytes, { flag: 'wx', mode: 0o600 });
    files.push({ path: file.path, sha256: file.sha256, scope: file.scope, output: String(index) });
  }
  if (!spelling) throw new RefusalError('spelling');
  process.stdout.write(JSON.stringify({ version: 1, files }) + '\n');
})().catch(() => { process.stdout.write(JSON.stringify({ version: 1, refusal: true }) + '\n'); });
`

async function executeCustomCapability(
    prepared: PreparedEnvironment,
    adapters: GeneratedEnvironmentCommandAdapters,
    harness: string,
    capability: Extract<DerivedRegistry['config']['surfaces']['harnesses'][number]['capabilities'][number], { state: 'enforced' | 'instructed' }>,
    sources: readonly SurfaceSourceFile[],
): Promise<{ receipt: CustomSurfaceReceipt; sources: readonly CustomSourceIdentity[]; evidence?: Readonly<{ reference: string; sha256: string }> } | undefined> {
    let evidenceSource: CustomSourceIdentity | undefined
    if (capability.state === 'enforced') {
        const evidenceRead = await readAnchoredFile(
            prepared.root, capability.evidence.reference, MAX_SURFACE_FILE_BYTES, prepared.node, adapters,
        )
        if (evidenceRead.kind !== 'complete' || evidenceRead.sha256 !== capability.evidence.sha256) return undefined
        evidenceSource = { harness, feature: capability.feature, path: capability.evidence.reference,
            sha256: evidenceRead.sha256, identity: evidenceRead.identity, maxBytes: MAX_SURFACE_FILE_BYTES }
    }
    const moduleRead = await readAnchoredFile(prepared.root, capability.mechanism.module, MAX_GENERATED_BYTES, prepared.node, adapters)
    if (moduleRead.kind !== 'complete') return undefined
    const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission'
        : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : undefined
    if (!permissionFlag || !process.allowedNodeEnvironmentFlags.has('--allow-fs-read')
        || !process.allowedNodeEnvironmentFlags.has('--allow-fs-write')) return undefined
    let scratch: string | undefined
    let scratchIdentity: DirectoryIdentity | undefined
    try {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-custom-surface-')))
        const scratchStatus = await lstat(scratch)
        if (!scratchStatus.isDirectory() || scratchStatus.isSymbolicLink()) return undefined
        scratchIdentity = { dev: scratchStatus.dev, ino: scratchStatus.ino }
        const input = snapshotGeneratedJson({ harness, feature: capability.feature, sources })
        if (!input) return undefined
        const absoluteModule = confined(prepared.root, capability.mechanism.module)
        if (!absoluteModule || [scratch, absoluteModule].some(path => path.includes('*'))) return undefined
        const request = { export: capability.mechanism.export, input, output: scratch,
            sourceSha256: moduleRead.sha256, spelling: capability.spelling }
        const raw = JSON.stringify(request)
        if (Buffer.byteLength(raw) > MAX_HELPER_FRAME_BYTES) return undefined
        const step = snapshotExecutionStep({
            id: `custom-surface-${harness}-${capability.feature}`, argv: [prepared.node.canonicalPath, permissionFlag,
                '--allow-fs-read', absoluteModule, `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`,
                '-e', CUSTOM_SURFACE_WORKER, raw, absoluteModule],
            argv0: prepared.node.invocationPath, cwd: scratch, env: {}, timeoutMs: HELPER_TIMEOUT_MS,
            spawnNotAfter: new Date(Date.now() + HELPER_TIMEOUT_MS).toISOString(), stdoutLimitBytes: MAX_HELPER_FRAME_BYTES,
            stderrLimitBytes: 16_384, paths: [prepared.root, scratch], ports: [], labels: { harness, feature: capability.feature }, expected: [],
            consumedFiles: [
                { path: prepared.node.canonicalPath, sha256: prepared.node.sha256, maxBytes: MAX_EXECUTABLE_BYTES, argvIndexes: [0], executable: true, executionMode: prepared.node.executionMode },
                { path: absoluteModule, sha256: moduleRead.sha256, maxBytes: MAX_GENERATED_BYTES, argvIndexes: [3, 9], executable: false },
            ], filesystemChecks: [{ path: scratch, expected: 'directory' }], compensation: [],
        })
        if (!step) return undefined
        const outcome = authenticatedExecutionOutcome(await adapters.execute(step), step)
        if (!outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0) return undefined
        const text = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout)
        const record = ownRecord(JSON.parse(text))
        if (!record || !exactKeys(record, ['version', 'files']) || record.version !== 1 || !Array.isArray(record.files)) return undefined
        const descriptors: Readonly<{ path: string; sha256: string; scope: 'always' | 'scoped'; output: string }>[] = []
        for (const [index, value] of record.files.entries()) {
            const row = ownRecord(value)
            if (!row || !exactKeys(row, ['path', 'sha256', 'scope', 'output']) || row.output !== String(index)
                || typeof row.path !== 'string' || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)
                || row.scope !== 'always' && row.scope !== 'scoped') return undefined
            descriptors.push({ path: row.path, sha256: row.sha256, scope: row.scope, output: row.output })
        }
        const reads = await readAnchoredBatches(scratch, descriptors.map(row => ({
            path: row.output, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
        })), prepared.node, adapters)
        if (!reads || reads.kind !== 'complete' || reads.results.length !== descriptors.length) return undefined
        const files: CustomSurfaceReceipt['files'][number][] = []
        for (const [index, row] of descriptors.entries()) {
            const read = reads.results[index]!
            if (read.kind !== 'complete' || read.sha256 !== row.sha256
                || read.identity.root.dev !== scratchIdentity.dev || read.identity.root.ino !== scratchIdentity.ino) return undefined
            const bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
            files.push({ path: row.path, bytes, sha256: row.sha256, scope: row.scope })
        }
        if (files.length === 0 || !files.some(file => file.path === capability.spelling || file.bytes.includes(capability.spelling))) return undefined
        const resultSha256 = surfaceModelSha256(files)
        if (!resultSha256) return undefined
        return {
            receipt: { harness, feature: capability.feature, state: capability.state, measuredOn: capability.measured_on,
                module: capability.mechanism.module, export: capability.mechanism.export, sourceSha256: moduleRead.sha256,
                resultSha256, files },
            sources: [
                { harness, feature: capability.feature, path: capability.mechanism.module,
                    sha256: moduleRead.sha256, identity: moduleRead.identity, maxBytes: MAX_GENERATED_BYTES },
                ...(evidenceSource ? [evidenceSource] : []),
            ],
            ...(capability.state === 'enforced' ? { evidence: { ...capability.evidence } } : {}),
        }
    } catch { /* an unavailable authority is refused by the caller. */ return undefined } finally {
        if (scratch && scratchIdentity) {
            try {
                const current = await lstat(scratch)
                if (current.isDirectory() && !current.isSymbolicLink()
                    && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino) {
                    await rm(scratch, { recursive: true, force: true })
                }
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) throw error
            }
        }
    }
}

async function projectExplicitNativeHooks(
    prepared: PreparedEnvironment,
    manifest: OwnershipManifest | undefined,
    adapters: GeneratedEnvironmentCommandAdapters,
    policyDeclaration: Readonly<{ path: string; sha256: string }>,
    harnesses: readonly string[],
) {
    if (!manifest) return undefined
    const policyRead = await readAnchoredFile(prepared.root, policyDeclaration.path, MAX_SURFACE_FILE_BYTES, prepared.node, adapters)
    if (policyRead.kind !== 'complete' || policyRead.sha256 !== policyDeclaration.sha256) return undefined
    let policyBytes: string
    try { policyBytes = new TextDecoder('utf-8', { fatal: true }).decode(policyRead.bytes) } catch { /* undecodable bytes are malformed input the caller refuses. */ return undefined }
    const policy: NativeHookPolicy = {
        manifest,
        authority: { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath },
        declarations: [],
        path: policyDeclaration.path,
        exists: true,
        bytes: policyBytes,
    }
    const source = { path: policyDeclaration.path, sha256: policyRead.sha256, identity: policyRead.identity }
    const git = await resolveGitExecutable(process.env)
    if (git.state !== 'available') return {
        projection: { kind: 'refusal' as const, reason: git.reason },
        source,
    }
    const revisionStep = snapshotExecutionStep({
        id: 'native-hook-revisions',
        argv: [git.value.invocationPath, 'rev-list', '--max-count=2', 'HEAD'],
        argv0: git.value.invocationPath,
        cwd: prepared.root,
        env: {},
        timeoutMs: HELPER_TIMEOUT_MS,
        spawnNotAfter: new Date(Date.now() + HELPER_TIMEOUT_MS).toISOString(),
        stdoutLimitBytes: 256,
        stderrLimitBytes: 4_096,
        paths: [prepared.root],
        ports: [],
        labels: { action: 'native-hook-revisions' },
        expected: [],
        consumedFiles: [{ path: git.value.canonicalPath, sha256: git.value.sha256, maxBytes: MAX_EXECUTABLE_BYTES,
            argvIndexes: [0], executable: true, executionMode: git.value.executionMode }],
        filesystemChecks: [{ path: prepared.root, expected: 'directory' }],
        compensation: [],
    })
    if (!revisionStep) return undefined
    const revisionOutcome = authenticatedExecutionOutcome(await adapters.execute(revisionStep), revisionStep)
    if (!revisionOutcome || revisionOutcome.kind !== 'complete' || revisionOutcome.stderr.byteLength !== 0) return undefined
    let revisions: string[]
    try { revisions = new TextDecoder('utf-8', { fatal: true }).decode(revisionOutcome.stdout).trim().split('\n') } catch { /* undecodable bytes are malformed input the caller refuses. */ return undefined }
    if (revisions.length !== 2 || revisions[0] === revisions[1]
        || revisions.some(value => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) || !/[1-9a-f]/.test(value))) return undefined
    let scratch: string | undefined
    let scratchIdentity: DirectoryIdentity | undefined
    try {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-native-hook-cost-')))
        const status = await lstat(scratch)
        if (!status.isDirectory() || status.isSymbolicLink()) return undefined
        scratchIdentity = { dev: status.dev, ino: status.ino }
        const shell = await resolveExecutablePath('/bin/sh')
        if (shell.state !== 'available') return undefined
        const projection = await projectNativeHooks({
            cockpitId: prepared.cockpitId,
            harnesses,
            install: 'explicit-native',
            budget: {
                policy,
                prepareMeasurement: async (entry: NativeHookEntry) => {
                    const path = join(scratch!, 'pre-push')
                    await writeFile(path, entry.bytes, { flag: 'wx', mode: 0o700 })
                    await chmod(path, 0o700)
                    const step = snapshotExecutionStep({
                        id: 'native-hook-cost',
                        argv: [shell.value.canonicalPath, '-c', NATIVE_HOOK_COST_SCRIPT, 'native-hook-cost', path, revisions[0]!, revisions[1]!],
                        argv0: shell.value.canonicalPath,
                        cwd: prepared.root,
                        env: { PATH: dirname(git.value.canonicalPath) },
                        timeoutMs: NATIVE_HOOK_COST_TIMEOUT_MS,
                        spawnNotAfter: new Date(Date.now() + HELPER_TIMEOUT_MS).toISOString(),
                        stdoutLimitBytes: 4_096,
                        stderrLimitBytes: 4_096,
                        paths: [prepared.root, scratch!],
                        ports: [],
                        labels: { action: 'native-hook-cost' },
                        expected: [],
                        consumedFiles: [
                            { path: shell.value.canonicalPath, sha256: shell.value.sha256, maxBytes: MAX_EXECUTABLE_BYTES,
                                argvIndexes: [0], executable: true, executionMode: shell.value.executionMode },
                            { path, sha256: entry.sha256, maxBytes: Buffer.byteLength(entry.bytes), argvIndexes: [4], executable: false },
                        ],
                        filesystemChecks: [{ path: prepared.root, expected: 'directory' }, { path: scratch!, expected: 'directory' }],
                        compensation: [],
                    })
                    if (!step) throw new RefusalError('native hook cost measurement could not be admitted')
                    return step
                },
            },
        })
        return {
            projection,
            source,
        }
    } finally {
        if (scratch && scratchIdentity) {
            try {
                const current = await lstat(scratch)
                if (current.isDirectory() && !current.isSymbolicLink()
                    && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino) {
                    await rm(scratch, { recursive: true, force: true })
                }
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) throw error
            }
        }
    }
}

async function prepareSurfaces(
    prepared: PreparedEnvironment,
    priorOwned: readonly SurfacePriorOwnedEntry[],
    adapters: GeneratedEnvironmentCommandAdapters,
    manifest?: OwnershipManifest,
): Promise<PreparedEnvironment | RefusalOutcome> {
    const config = prepared.registry.config
    // Only the listed tools are rendered and drift-checked; an unlisted tool's files become stale.
    const tools = listedSurfaceTargets(config.surfaces.tools)
    const guardedTools = GUARD_SURFACE_TARGETS.filter(target => tools.includes(target))
    const selected = config.sibling.filter(row => row.mount === 'always')
    const requiredSlugs = new Set([...selected.map(row => row.slug), ...prepared.registry.mcpSources.map(row => row.slug)])
    const siblingRoots = new Map<string, string>()
    const sourceRoots: SourceRootIdentity[] = []
    if (!await siblingRootsCurrent(prepared.siblingRoots)) return refuse(
        'GENERATED_SIBLING_ROOT_INVALID', 'a sibling directory changed after its root authority was authenticated', 'sibling',
    )
    try {
        for (const sibling of config.sibling.filter(row => requiredSlugs.has(row.slug))) {
            const authority = prepared.siblingRoots.siblings.get(sibling.slug)
            if (!authority) throw new RefusalError('root')
            const root = authority.root
            const status = await lstat(root)
            if (!status.isDirectory() || status.isSymbolicLink()) throw new RefusalError('root')
            siblingRoots.set(sibling.slug, root)
            sourceRoots.push({ slug: sibling.slug, root, identity: authority.identity })
        }
    } catch (error) {
        return refuse('SURFACE_SOURCE_UNAVAILABLE', `an active sibling checkout could not be authenticated: ${errorCause(error)}`, 'surfaces')
    }
    // A root guide that projection also writes would become both an authenticated input and an
    // owned output. Native harness loading already reaches these files, so a copy adds no rule.
    const rootInstructionOutputs = new Set(['AGENTS.md', 'CLAUDE.md', 'opencode.jsonc'])
    const projectionGuides = (sibling: typeof config.sibling[number]): readonly string[] =>
        siblingRoots.get(sibling.slug) === prepared.root
            ? sibling.guides.filter(guide => !rootInstructionOutputs.has(guide))
            : sibling.guides
    const guideRequests = selected.flatMap(sibling => projectionGuides(sibling).map(guide => ({
        slug: sibling.slug, root: siblingRoots.get(sibling.slug)!, sourcePath: resolve(siblingRoots.get(sibling.slug)!, guide),
    }))).sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath))
    const observedGuides = guideRequests.length === 0
        ? { kind: 'complete' as const, observations: [] as readonly GuideObservation[], missing: [] as readonly string[] }
        : await observeSiblingGuides({ allowedRoots: selected.map(row => siblingRoots.get(row.slug)!), requests: guideRequests })
    if (observedGuides.kind !== 'complete') return refuse(observedGuides.diagnostic.code, observedGuides.diagnostic.message, observedGuides.diagnostic.target)
    for (const sibling of selected) for (const guide of projectionGuides(sibling)) {
        const sourcePath = resolve(siblingRoots.get(sibling.slug)!, guide)
        if (!SIBLING_DEFAULT_GUIDES.includes(guide) && observedGuides.missing.includes(sourcePath)) return siblingGuideMissing(sibling.slug, guide, sourcePath)
    }
    const projectionInput: ProjectionPlannerInput = {
        canonicalMainCheckout: prepared.root,
        siblingsRoot: config.cockpit.siblings_root,
        activeProfiles: [],
        guideCapLines: config.cockpit.guide_cap,
        siblings: config.sibling.map(row => ({ slug: row.slug, mount: row.mount, directoryAuthority: row.dir, guides: [...projectionGuides(row)] })),
        mountedPaths: selected.map(row => ({ slug: row.slug, path: siblingRoots.get(row.slug)! })),
        directoryGrants: selected.flatMap(row => tools.map(target => ({ slug: row.slug, target, path: siblingRoots.get(row.slug)! }))),
        guideObservations: observedGuides.observations,
        standingSources: [],
        loadCharacterizations: GUIDE_LOAD_CHARACTERIZATIONS,
        targets: tools,
    }
    let projection = planSiblingProjection(projectionInput)
    if (projection.kind !== 'complete') return refuse(projection.diagnostic.code, projection.diagnostic.message, projection.diagnostic.target)

    const evidence: SurfaceInputEvidence[] = observedGuides.observations.map(row => ({
        kind: 'guide' as const, root: siblingRoots.get(row.slug)!, path: row.sourcePath,
        sha256: row.contentSha256, identity: row.contentIdentity,
    }))
    const declarations = []
    for (const source of prepared.registry.mcpSources) {
        const root = siblingRoots.get(source.slug)
        if (!root) continue
        const read = await readAnchoredFile(root, source.path, MAX_GENERATED_BYTES, prepared.node, adapters)
        if (read.kind !== 'complete') return refuse('MCP_DECLARATION_INVALID', 'an MCP declaration source is unavailable', source.path)
        let bytes: string
        try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) } catch {
            // undecodable bytes are malformed input the caller refuses.
            return refuse('MCP_DECLARATION_INVALID', 'an MCP declaration source is not UTF-8', source.path)
        }
        const parsed = parseMcpDeclarationFile({ bytes, source: { kind: 'sibling', slug: source.slug, path: source.path, sha256: read.sha256 }, workingDirectory: root })
        if (parsed.kind !== 'complete') return refuse(parsed.diagnostic.code, parsed.diagnostic.message, source.path)
        declarations.push(...parsed.declarations)
        evidence.push({ kind: 'mcp' as const, root, path: source.path, sha256: read.sha256, identity: sourceIdentity(read.identity) })
    }
    // Under [autonomy] mcp_approve = "agent" every declared server is approved as declared now; under
    // "person" only the digests a person recorded in [mcp.approved] are, and the guard pins that table.
    const approved = effectivePolicy(config).autonomy.mcp_approve === 'agent'
        ? { ...config.mcp.approved, ...Object.fromEntries(declarations.map(row => [row.name, mcpApprovalDigest(row, prepared.root)])) }
        : config.mcp.approved
    let mcp = collectMcpDeclarations({ cockpitDirectory: prepared.root, declarations, approved, targets: tools })
    if (mcp.kind !== 'complete') return refuse(mcp.diagnostic.code, mcp.diagnostic.message, mcp.diagnostic.server)
    const unapprovedMcpServers = mcp.diagnostics.filter(row => row.code === 'MCP_NOT_APPROVED' && row.server !== undefined)
        .map(row => ({ name: row.server!, sha256: row.sha256!, sources: (row.sources ?? []).map(source =>
            source.kind === 'sibling' ? `${source.slug}:${source.path}` : source.path) }))
    if (mcp.diagnostics.some(row => row.code === 'MCP_APPROVAL_UNKNOWN')) {
        const row = mcp.diagnostics.find(candidate => candidate.code === 'MCP_APPROVAL_UNKNOWN')!
        return refuse(row.code, row.message, row.server)
    }

    const assetPaths = [EVALUATOR_ASSET, ...SKILL_ASSETS, ...REFERENCE_ASSETS, ...RESTRICTION_ASSETS, ...WORK_ASSETS]
    const assetReads = await readAnchoredBatches(SURFACE_ROOT, assetPaths.map(path => ({
        path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
    })), prepared.node, adapters)
    if (!assetReads || assetReads.kind !== 'complete' || assetReads.results.length !== assetPaths.length) {
        return refuse('SURFACE_INPUT_INVALID', 'a shipped surface asset could not be authenticated', 'surfaces')
    }
    const assetRows = assetPaths.map((path, index) => readSurfaceAsset(path, assetReads.results[index]!))
    if (assetRows.some(row => row === undefined)) return refuse('SURFACE_INPUT_INVALID', 'a shipped surface asset could not be authenticated', 'surfaces')
    const assets = assetRows as readonly NonNullable<typeof assetRows[number]>[]
    const asset = (path: SurfaceAssetPath): NonNullable<typeof assetRows[number]> => assets.find(row => row.path === path)!
    let browser: ReturnType<typeof renderBrowserSurfaces> | null = null
    let browserAuthority: ConsumedWorkApplicationAuthorities['browser']
    if (prepared.workEnvironment.browser) {
        const checkout = prepared.runtimeCheckout
        if (!checkout) return refuse('SURFACE_INPUT_INVALID', 'browser checkout identity is unavailable', prepared.configPath)
        const browserConfiguration = prepared.workEnvironment.browser
        const playwright = declarations.filter(row => row.name === 'playwright')
        if (playwright.length !== 1) {
            return refuse('MCP_DECLARATION_INVALID',
                `[browser] requires exactly one MCP server named playwright, and the declared MCP sources hold ${playwright.length}`, 'playwright',
                'declare one playwright server in a JSON file with an mcpServers object, listed in a sibling\'s derives.mcp_sources, then run npx --no cockpit sync --config <your cockpit.toml>')
        }
        const playwrightDigest = mcpApprovalDigest(playwright[0]!, prepared.root)
        if (config.mcp.approved.playwright !== playwrightDigest) {
            return refuse('MCP_DECLARATION_INVALID', `[browser] requires the playwright MCP server to be approved at its current declaration (sha256 ${playwrightDigest})`, 'playwright',
                'review the playwright declaration, set playwright to the sha256 in this message under [mcp.approved], then run npx --no cockpit sync --config <your cockpit.toml>')
        }
        if (process.platform !== 'darwin' && process.platform !== 'linux') {
            return refuse('SURFACE_INPUT_INVALID', 'browser posture state is unavailable on this platform', process.platform)
        }
        const observedAt = new Date().toISOString()
        const currentStack = stackId({ cockpitId: checkout.cockpitId, checkoutId: checkout.checkoutId, variant: { kind: 'shared' } })
        const configuration = (await observeConfiguration({ path: prepared.configPath, stackId: currentStack, observedAt }))
            .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)
        const namespace = await selectStateRoot({
            platform: process.platform,
            home: process.env.HOME,
            xdgStateHome: process.env.XDG_STATE_HOME,
            checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath],
            cockpitId: checkout.cockpitId,
        })
        if (!configuration) {
            return refuse('SURFACE_INPUT_INVALID', 'browser posture authority could not be observed', prepared.configPath)
        }
        if (namespace.kind !== 'complete') return namespace.kind === 'refusal'
            ? refuse('SURFACE_INPUT_INVALID', namespace.message, namespace.target)
            : refuse('SURFACE_INPUT_INVALID', `browser posture state is ${namespace.kind}`, prepared.root)
        try {
            const authority = await resolveObservationPostures({
                configuration,
                cockpitId: checkout.cockpitId,
                checkoutPath: checkout.currentCheckoutPath,
                variant: { kind: 'shared' },
            })
            const stage = await resolveLifecycleStage({ namespace: namespace.value, stackId: currentStack, observedAt })
            if (stage.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'browser lifecycle authority could not be observed', prepared.root)
            const configuredRuntime = resolveBrowserRuntime({
                ...browserConfiguration,
                postures: { authorities: [authority], stages: [stage.authority] },
            }, namespace.value)
            const runtime = configuredRuntime
            const browserMcp = playwright[0]!
            const browserSkill = asset('skills/cockpit-browser.skill.md')
            browser = renderBrowserSurfaces({
                runtime,
                cockpitDirectory: prepared.root,
                harnesses: browserConfiguration.harnesses.flatMap(row => isGuardSurfaceTarget(row.target)
                    ? [{ target: row.target, version: row.version }] : []),
                mcp: browserMcp,
                approved: true,
                testPackage: null,
                skillTemplate: browserSkill.bytes,
            })
            const browserTargets = new Set(browser.mcp.result.harnesses
                .filter(row => row.servers.some(server => server.name === 'playwright'))
                .map(row => row.target))
            const boundMcp = collectMcpDeclarations({
                cockpitDirectory: prepared.root,
                declarations: declarations.flatMap(row => row.name !== 'playwright' ? [row]
                    : browserTargets.size ? [browserMcp] : []),
                // The leased endpoint rewrites an approved argument, so the bound server carries its own digest.
                approved: { ...Object.fromEntries(Object.entries(approved).filter(([name]) => name !== 'playwright')),
                    ...(browserTargets.size > 0 ? { playwright: mcpApprovalDigest(browserMcp, prepared.root) } : {}) },
                targets: tools,
            })
            if (boundMcp.kind !== 'complete') throw new RefusalError(`bound browser MCP declaration was refused: ${boundMcp.diagnostic.code}`)
            mcp = { ...boundMcp, result: { ...boundMcp.result,
                harnesses: boundMcp.result.harnesses.map(row => ({ ...row,
                    servers: row.servers.filter(server => server.name !== 'playwright' || browserTargets.has(row.target)),
                })),
            } }
            browserAuthority = {
                runtime,
                namespace: namespace.value,
                mcp: browserMcp,
                skillTemplate: browserSkill,
            }
        } catch (error) {
            return refuse('SURFACE_INPUT_INVALID', `browser surface projection was refused: ${errorCause(error)}`, 'browser')
        }
    }
    const testingRegistry = prepared.workEnvironment.testing
        ? createGateRegistry(prepared.workEnvironment.testing.declarations)
        : TESTING_GUIDE_REGISTRY
    const configuredHarnesses = [...tools, ...config.surfaces.harnesses.map(row => row.name)].sort()
    const testingConfiguration = prepared.workEnvironment.testing
    const explicitNativeHooks = testingConfiguration?.nativeHookInstall === 'explicit-native'
        ? testingConfiguration.nativeHookPolicy
            ? await projectExplicitNativeHooks(prepared, manifest, adapters, testingConfiguration.nativeHookPolicy, configuredHarnesses)
            : undefined
        : undefined
    const nativeHooks = testingConfiguration?.nativeHookInstall === 'explicit-native'
        ? explicitNativeHooks?.projection
        : await projectNativeHooks({
            cockpitId: prepared.cockpitId,
            harnesses: configuredHarnesses,
            install: 'inspect',
        })
    if (!nativeHooks) return refuse('SURFACE_INPUT_INVALID', 'explicit native hook policy or measurement is unavailable', '.githooks/pre-push')
    if (testingConfiguration?.nativeHookInstall === 'explicit-native' && nativeHooks.kind !== 'complete') {
        return refuse('SURFACE_INPUT_INVALID', nativeHooks.reason, '.githooks/pre-push')
    }
    const coreAssets = new Map(assets.map(row => [row.path, row] as const))
    const coreDeclarations = coreSurfaceDeclarations(coreAssets)
    if (!coreDeclarations) return refuse('SURFACE_INPUT_INVALID', 'the shipped core surface declarations could not be read', 'skills/collection.json')
    const shippedSkills = coreDeclarations.filter(declaration => declaration.feature === 'skills').map(declaration => declaration.name)
    const merge = mergeSurfaceDeclarations(coreDeclarations, config.surfaces.overlays)
    if (merge.kind !== 'complete') return refuse(merge.code, merge.message, 'surfaces')
    const mergedSources: SurfaceSourceFile[] = []
    for (const source of merge.surfaces.flatMap(surface => surface.sources)) {
        if (!source.path.startsWith('rules/')) { mergedSources.push({ path: source.path, bytes: source.bytes }); continue }
        const rule = alwaysLoadedRule(source.bytes)
        if (rule.kind === 'refusal') return refuse('SURFACE_RULE_SCOPE_UNSUPPORTED', `rules overlay ${source.path} ${rule.reason}`, source.path,
            'remove `globs` from the rule frontmatter, or narrow the rule text itself to the files it is about, then run npx --no cockpit sync --config <your cockpit.toml>')
        mergedSources.push({ path: source.path, bytes: rule.bytes })
    }
    // Every sibling directory relative to the cockpit root, whether or not a grant names it.
    const siblingDirectories = [...prepared.siblingRoots.siblings].map(([slug, sibling]) => ({ slug, path: relative(prepared.root, sibling.root) }))
    const generatedNativeSources = nativeSources(mcp, projection.grants, siblingDirectories, prepared.registry.secretPaths)
    const generatedSources = [...mergedSources, ...generatedNativeSources]
        .sort((left, right) => compareCodeUnits(left.path, right.path))
    if (new Set(generatedSources.map(source => source.path)).size !== generatedSources.length) {
        return refuse('SURFACE_PATH_CONFLICT', 'surface source paths collide with generated native sources', 'surfaces')
    }
    const features = SURFACE_FEATURES.filter(feature => generatedSources.some(source => source.path === `${feature}.jsonc`
        || source.path.startsWith(`${feature}/`) || feature === 'rules' && source.path.startsWith('rules/')
        || feature === 'subagents' && source.path.startsWith('subagents/') || feature === 'skills' && source.path.startsWith('skills/')))
    const bundleEntries: SurfaceDesiredEntry[] = []
    const expected = expectedSurfaceOutputs(tools, features, generatedSources)
    const bundleRequest = config.surfaces.bundles.includes('claudecode-plugin') ? (() => {
        const bundleFeatures = features.filter(feature => feature === 'mcp' || feature === 'subagents'
            || feature === 'skills' || feature === 'hooks')
        const bundleSources = generatedSources.filter(source => source.path === 'mcp.jsonc' || source.path === 'hooks.jsonc'
            || source.path.startsWith('subagents/') || source.path.startsWith('skills/'))
        return {
            format: 'claudecode-plugin' as const,
            features: bundleFeatures,
            sources: bundleSources,
            expectedOutputs: expectedClaudePluginOutputs(bundleFeatures, bundleSources),
        }
    })() : undefined
    const estate = generatedSources.length === 0 ? undefined : await generateSurfaceEstate({
        batch: { targets: tools, features, sources: generatedSources, expectedOutputs: expected },
        ...(bundleRequest ? { bundle: bundleRequest } : {}),
    })
    if (estate && estate.kind !== 'complete') {
        // The generator prints its warnings before the error that stopped it, then a stack; lead with
        // that error and drop the stack, which names only the worker's scratch files.
        const failure = estate.diagnostics[0]
        const said = failure?.stderr?.split('\n').map(line => line.trim().replace(/^Error: /, ''))
            .filter(line => line.length > 0 && !/^at /.test(line)) ?? []
        const cause = said.at(-1)
        return refuse('SURFACE_GENERATION_FAILED', [cause, failure?.message ?? 'built-in surface generation was refused',
            ...said.length > 1 ? [`generator output: ${said.slice(0, -1).join(' ')}`] : []]
            .filter((part): part is string => part !== undefined).join('; '), failure?.target)
    }
    const generated = estate?.kind === 'complete' && estate.batch ? estate.batch : emptyGeneration()

    if (config.surfaces.bundles.includes('claudecode-plugin')) {
        const bundle = estate?.kind === 'complete' ? estate.bundle : undefined
        if (!bundle) return refuse('SURFACE_GENERATION_FAILED', 'Claude plugin bundle generation was refused', 'claudecode-plugin')
        const manifest = claudePluginManifest()
        // A bundled skill must carry the references its SKILL.md tells the agent to read.
        const references = bundle.files.some(file => file.path === `skills/${SHIPPED_SETUP_SKILL}/SKILL.md`)
            ? REFERENCE_ASSETS.map(path => {
                const bytes = stripDevelopmentMarkers(asset(path).bytes)
                return { path: `skills/${SHIPPED_SETUP_SKILL}/${path}`, bytes, sha256: sha256(bytes) }
            }) : []
        const files = [
            { path: '.claude-plugin/plugin.json', ...manifest },
            ...bundle.files,
            ...references,
        ]
        for (const file of files) bundleEntries.push({
            kind: 'file' as const,
            ownership: 'whole-file' as const,
            path: `.cockpit/bundles/claudecode-plugin/${file.path}`,
            bytes: file.bytes,
            sha256: file.sha256,
            harnesses: ['claudecode'] as readonly ['claudecode'],
            scope: 'always' as const,
            capability: 'instructed' as const,
            writer: 'cockpit' as const,
            schemaVersion: 1 as const,
        })
    }

    const skillSources = generatedSources.filter(source => source.path.startsWith('skills/'))
    const skillAsset = (path: SurfaceAssetPath) => {
        const { bytes, sha256 } = asset(path)
        return { path, bytes, sha256 }
    }
    const skillInspection = await inspectRenderedSkillSet({ sources: skillSources,
        declaredExtensions: config.surfaces.overlays.filter(overlay => overlay.feature === 'skills')
            .flatMap(overlay => overlay.sources.flatMap(source => /^skills\/([^/]+)\/SKILL\.md$/.exec(source.path)?.[1] ?? []))
            .filter(name => !shippedSkills.some(shipped => shipped === name))
            .sort(compareCodeUnits),
        collection: skillAsset('skills/collection.json'), procedures: PROCEDURE_ASSETS.map(skillAsset), generated, targets: tools })
    if (skillInspection.kind !== 'complete') {
        const diagnostic = skillInspection.diagnostics[0]
        return refuse(diagnostic?.code ?? 'SKILL_RENDER_INVALID', diagnostic?.message ?? 'rendered skill set was refused', diagnostic?.target)
    }

    let modulePath: string
    try { modulePath = await realpath(fileURLToPath(new URL('../../dist/cli.js', import.meta.url))) }
    catch (error) { return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', `the installed guard handler is unavailable: ${errorCause(error)}`, 'guard') }
    const moduleRead = await readAnchoredFile(dirname(modulePath), basename(modulePath), MAX_GENERATED_BYTES, prepared.node, adapters)
    if (moduleRead.kind !== 'complete') return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', 'the installed guard handler is unavailable', 'guard')
    const rootStat = await lstat(prepared.root)
    const configStat = await lstat(prepared.configPath)
    // Only a fingerprint this process hashed to the authenticated digest may stand in for a re-hash.
    const nodeFingerprint = fileFingerprint(prepared.node.canonicalPath, await lstat(prepared.node.canonicalPath))
    if (verifiedDigest(nodeFingerprint) !== prepared.node.sha256) return refuse('GENERATED_EXECUTABLE_UNAVAILABLE',
        'the Node executable changed while sync was running', 'guard', 'run `npx --no cockpit sync --config <your cockpit.toml>` again in a terminal')
    const guardHandler: GuardHandlerIdentity = { root: prepared.root,
        rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino),
        configPath: prepared.configPath, configSha256: prepared.sourceSha256,
        configDevice: String(configStat.dev), configInode: String(configStat.ino),
        node: prepared.node.canonicalPath, nodeSha256: prepared.node.sha256, nodeFingerprint,
        module: modulePath, moduleSha256: moduleRead.sha256 }
    const restrictions = expandRestrictions({
        canonicalProjectRoot: prepared.root,
        allowedProjectRoots: [...new Set([prepared.root, ...selected.map(row => siblingRoots.get(row.slug)!)])].sort(compareCodeUnits),
        guardTemplate: asset(RESTRICTION_ASSETS[0]).bytes, guardPath: '.cockpit/guards/bash-guard.sh',
        instances: prepared.registry.secretPaths.filter(row => siblingRoots.has(row.slug)).map(row => ({
            kind: 'instance' as const, name: `${row.slug}-${sha256(row.path).slice(0, 12)}`, root: siblingRoots.get(row.slug)!, path: row.path,
        })),
        policy: { hosted_db_hosts: config.guards.hosted_db_hosts, protected_branches: config.guards.protected_branches,
            readonly: { kind: 'agent', name: 'evaluator' } },
        adapters: RESTRICTION_ASSETS.slice(1).map(path => JSON.parse(asset(path).bytes)),
        configFile: relative(prepared.root, prepared.configPath),
    })
    if (restrictions.kind !== 'complete') return refuse(restrictions.code, restrictions.message, 'surfaces')
    const listedRestrictions = { ...restrictions,
        targets: restrictions.targets.filter(row => tools.includes(row.target)) }

    const customReceipts: CustomSurfaceReceipt[] = []
    const customSources: CustomSourceIdentity[] = []
    const customSelftest: GeneratedCustomSurfaceSelftestInput[] = []
    for (const harness of config.surfaces.harnesses) for (const capability of harness.capabilities) {
        if (capability.state === 'unavailable') continue
        const sources = merge.surfaces.filter(surface => surface.feature === capability.feature).flatMap(surface => surface.sources)
            .map(source => ({ path: source.path, bytes: source.bytes })).sort((left, right) => compareCodeUnits(left.path, right.path))
        const result = await executeCustomCapability(prepared, adapters, harness.name, capability, sources)
        if (!result) return refuse('SURFACE_CUSTOM_REFUSED', 'a custom harness capability did not return an authenticated complete file set', `${harness.name}:${capability.feature}`)
        customReceipts.push(result.receipt)
        customSources.push(...result.sources)
        const { harness: name, feature, state, measuredOn, module, export: exportName, sourceSha256, resultSha256 } = result.receipt
        customSelftest.push({ harness: name, feature, state, measuredOn, module, export: exportName, sourceSha256, resultSha256, sources,
            ...(result.evidence ? { evidence: result.evidence } : {}) })
    }
    const mcpTargets = mcp.result.harnesses.filter(row => row.servers.length > 0).map(row => row.target)
    const grantTargets = [...new Set(projection.grants.map(row => row.target))]
    const generatedNativeMcp = nativeFragmentSet(generated, mcp.result, nativeMcpPaths(mcpTargets))
    const nativeGrants = nativeGrantFragmentSet(generated, projection.grants, nativeGrantPaths(grantTargets),
        openCodeReadDenials(siblingDirectories, prepared.registry.secretPaths))
    const nativeMcp = generatedNativeMcp && nativeGrants ? bindNativeGrantsToMcp(generatedNativeMcp, nativeGrants) : undefined
    if (!nativeMcp || !nativeGrants) return refuse('SURFACE_INPUT_INVALID', 'native surface fragments could not be bound', 'surfaces')
    const browserSkillRendered = browser?.files.some(file => file.path.endsWith('/skills/cockpit-browser/SKILL.md')) === true
    const instructions = renderConsumerInstructions({
        name: config.cockpit.name,
        configFile: relative(prepared.root, prepared.configPath),
        siblings: config.sibling.map(row => ({ dir: row.dir, purpose: row.purpose, acquire: row.acquire })),
        hasStack: config.environment.compose_files.length > 0,
        guards: { declaredDatabaseHosts: config.guards.hosted_db_hosts, declaredVendorHosts: config.guards.vendor_endpoint_hosts,
            pushRefusedBranches: config.guards.protected_branches },
        skills: [
            ...merge.surfaces.filter(surface => surface.feature === 'skills').flatMap(surface => surface.sources
                .filter(source => /^skills\/[^/]+\/SKILL\.md$/.test(source.path))
                .map(source => ({ name: source.path.split('/')[1]!, description: skillDescription(source.bytes) }))),
            ...(browserSkillRendered ? [{ name: 'cockpit-browser', description: skillDescription(asset('skills/cockpit-browser.skill.md').bytes) }] : []),
        ],
    })
    const generatedRootInstructions = generated.files.filter(file => file.path === 'AGENTS.md')
    const distinctGeneratedRoots = [...new Set(generatedRootInstructions.map(file => file.bytes))]
    if (distinctGeneratedRoots.length > 1) return refuse(
        'SURFACE_PATH_CONFLICT', 'generated root instructions diverge across always-loaded harnesses', 'AGENTS.md',
    )
    const rootInstructions = distinctGeneratedRoots[0]
    const commonRootInstructions = [rootInstructions?.replace(/\n+$/u, ''), instructions.replace(/\n+$/u, '')]
        .filter((value): value is string => value !== undefined && value.length > 0).join('\n') + '\n'
    projectionInput.standingSources = guardedTools.map(target => ({
        target,
        path: 'AGENTS.md',
        content: commonRootInstructions,
        scope: 'always' as const,
    }))
    projection = planSiblingProjection(projectionInput)
    if (projection.kind !== 'complete') return refuse(projection.diagnostic.code, projection.diagnostic.message, projection.diagnostic.target)
    const tierGuide = renderTierGuide(testingRegistry, projectionInput)
    if (tierGuide.kind !== 'complete') return tierGuide.exceeded ? guideCapExceeded(tierGuide.exceeded) : refuse('SURFACE_INPUT_INVALID', tierGuide.reason, 'testing-tiers')
    if (!prepared.workEnvironment.testing && tierGuide.bytes !== stripDevelopmentMarkers(asset('references/testing-tiers.md').bytes)) {
        return refuse('SURFACE_INPUT_INVALID', 'the shipped testing tier guide differs from its canonical registry projection', 'references/testing-tiers.md')
    }
    const rendered = renderSurfaceSet({ configuredHarnesses, merge, generated, projection, mcp, restrictions: listedRestrictions, instructions,
        nativeMcp, nativeGrants, browser, browserReference: browser ? asset('references/browser.md').bytes : null,
        skillReferences: REFERENCE_ASSETS.map(path => ({ skill: SHIPPED_SETUP_SKILL, path, bytes: asset(path).bytes })),
        testing: { tierGuide, nativeHooks },
        customHarnesses: config.surfaces.harnesses, customReceipts, sourceEvidence: evidence })
    if (rendered.kind !== 'complete') return refuse(rendered.diagnostic.code, rendered.diagnostic.message, rendered.diagnostic.target)
    const adopted = await mergeAdoptedSurfaces(prepared, rendered.entries, configuredHarnesses, adapters)
    if ('status' in adopted) return adopted
    let adoptedEntries = adopted.entries
    if (adopted.entries.some(entry => entry.path === 'CLAUDE.md')) {
        const existingClaude = await readAnchoredEntry(prepared.root, 'CLAUDE.md', MAX_SURFACE_FILE_BYTES, prepared.node, adapters)
        if (existingClaude.kind === 'invalid') return refuse('SURFACE_STATE_CONFLICT', 'the existing Claude guide could not be observed safely', 'CLAUDE.md')
        if (existingClaude.kind === 'file') {
            let bytes: string
            try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(existingClaude.bytes) } catch {
                // undecodable bytes are malformed input the caller refuses.
                return refuse('SURFACE_STATE_CONFLICT', 'the existing Claude guide is not UTF-8', 'CLAUDE.md')
            }
            const priorClaude = priorOwned.find(entry => entry.path === 'CLAUDE.md')
            let unmanaged = bytes
            if (priorClaude?.kind === 'shared-region' && priorClaude.region.format === 'markdown-delimited') {
                const start = bytes.indexOf(priorClaude.region.begin)
                const end = bytes.indexOf(priorClaude.region.end, start + priorClaude.region.begin.length)
                if (start >= 0 && end > start) unmanaged = `${bytes.slice(0, start)}${bytes.slice(end + priorClaude.region.end.length)}`
            }
            const imports = activeClaudeImports(unmanaged)
            if (imports.length > 1) {
                return refuse('SURFACE_STATE_CONFLICT', 'the existing Claude guide contains ambiguous AGENTS.md imports', 'CLAUDE.md')
            }
            if (priorClaude === undefined && bytes.includes('<!-- cockpit:')) {
                return refuse('SURFACE_STATE_CONFLICT', 'the existing Claude guide contains an unowned cockpit marker', 'CLAUDE.md')
            }
            if (imports.length === 1) {
                adoptedEntries = adopted.entries.filter(entry => entry.path !== 'CLAUDE.md')
            }
        }
    }
    const bound = bindSurfaceOwnershipIdentity(adoptedEntries, prepared.cockpitId)
    if (bound.kind !== 'complete') return refuse(bound.diagnostic.code, bound.diagnostic.message, bound.diagnostic.target)
    const surfaceEntries = [...bound.entries, ...bundleEntries]
        .sort((left, right) => compareCodeUnits(left.path, right.path))
    const browserSkillFiles: RenderedSurfaceFile[] = []
    const renderedBrowserSkills = browser?.files.filter(file => file.path.endsWith('/skills/cockpit-browser/SKILL.md')) ?? []
    const publishedBrowserSkills = surfaceEntries.filter(entry => entry.path.endsWith('/skills/cockpit-browser/SKILL.md'))
    for (const entry of publishedBrowserSkills) {
        if (entry.kind !== 'file') return refuse('SURFACE_INPUT_INVALID', 'the browser skill must be a whole owned file', entry.path)
        for (const target of entry.harnesses) {
            const rendered = renderedBrowserSkills.find(file => file.path === entry.path && file.target === target)
            const bytes = rendered && stripDevelopmentMarkers(rendered.bytes)
            if (!rendered || bytes !== entry.bytes || sha256(bytes) !== entry.sha256) {
                return refuse('SURFACE_INPUT_INVALID', 'the published browser skill differs from its authenticated renderer', entry.path)
            }
            browserSkillFiles.push({ target: rendered.target, path: entry.path, bytes, sha256: entry.sha256 })
        }
    }
    if (renderedBrowserSkills.length !== browserSkillFiles.length
        || renderedBrowserSkills.some(file => !browserSkillFiles.some(published => published.path === file.path && published.target === file.target))) {
        return refuse('SURFACE_INPUT_INVALID', 'the published browser skill inventory is incomplete', 'surfaces')
    }
    const installedSkillInspection = extendInspectedSkillStandingCosts(skillInspection, browserSkillFiles)
    if (installedSkillInspection.kind !== 'complete') {
        const diagnostic = installedSkillInspection.diagnostics[0]
        return refuse(diagnostic.code, diagnostic.message, diagnostic.target ?? 'surfaces')
    }
    const rootGuide = surfaceEntries.find(entry => entry.path === 'AGENTS.md')
    if (!rootGuide || rootGuide.kind !== 'shared-region' || rootGuide.region.format !== 'markdown-delimited') {
        return refuse('SURFACE_INPUT_INVALID', 'the published always-loaded root guide is unavailable', 'AGENTS.md')
    }
    const characterizedGuideCosts = tierGuide.costs.filter(
        (cost): cost is Exclude<StandingCost, { status: 'unavailable' }> => cost.status !== 'unavailable',
    )
    if (characterizedGuideCosts.length !== tierGuide.costs.length) {
        return refuse('SURFACE_INPUT_INVALID', 'published instruction cost is not characterized', 'AGENTS.md')
    }
    // The root region carries the copied sibling guides, so every tool's start-up cost is that region.
    const rootGuideLines = guideLines(rootGuide.region.bytes)
    const actualGuideCosts = characterizedGuideCosts.map(cost =>
        ({ ...cost, value: rootGuideLines, status: rootGuideLines > cost.cap ? 'exceeded' as const : 'within_cap' as const }))
    const rootGuideBytes = Buffer.byteLength(rootGuide.region.bytes)
    if (rootGuideBytes > CODEX_PROJECT_DOC_BYTES) return guideBytesExceeded(rootGuideBytes)
    const overCap = actualGuideCosts.filter(cost => cost.status === 'exceeded').sort((left, right) => right.value - left.value)[0]
    if (overCap) return guideCapExceeded(overCap)
    if (explicitNativeHooks && !surfaceEntries.some(entry => entry.kind === 'file'
        && entry.path === explicitNativeHooks.source.path && entry.sha256 === explicitNativeHooks.source.sha256)) {
        return refuse('SURFACE_INPUT_INVALID', 'native hook policy must remain an exact desired owned surface', explicitNativeHooks.source.path)
    }
    if (new Set(surfaceEntries.map(entry => entry.path)).size !== surfaceEntries.length) {
        return refuse('SURFACE_PATH_CONFLICT', 'generated surface and bundle paths collide', 'surfaces')
    }
    if (new Set([...prepared.owned, ...surfaceEntries].map(entry => entry.path)).size !== prepared.owned.length + surfaceEntries.length) {
        return refuse('SURFACE_PATH_CONFLICT', 'generated environment and surface paths collide', 'surfaces')
    }
    if (prepared.owned.length + surfaceEntries.length > MAX_OWNED_FILES) {
        return refuse('SURFACE_BOUNDS', 'combined generated ownership exceeds the entry bound', 'surfaces')
    }
    const selftestPayload = {
        schema: 'cockpit-generated-surface-selftest/v1' as const,
        configuredHarnesses,
        declarations: config.surfaces.harnesses,
        entries: surfaceEntries,
        custom: customSelftest.sort((left, right) => compareCodeUnits(`${left.harness}\0${left.feature}`, `${right.harness}\0${right.feature}`)),
    }
    const captured = snapshotGeneratedJson(selftestPayload) as unknown as Omit<GeneratedSurfaceSelftestProjection, 'manifestSha256'> | undefined
    if (!captured) return refuse('SURFACE_BOUNDS', 'authenticated selftest inputs exceed the captured bounds', 'surfaces')
    const payload = { schema: captured.schema, configuredHarnesses: selftestPayload.configuredHarnesses,
        declarations: captured.declarations, entries: surfaceEntries, custom: captured.custom }
    const surfaceSelftest = { ...payload, manifestSha256: sha256(JSON.stringify(payload)) }
    const skillInventory = surfaceEntries.filter((entry): entry is Extract<SurfaceDesiredEntry, { kind: 'file' }> =>
        entry.kind === 'file').flatMap(entry => entry.harnesses.flatMap(target => {
        if (!SURFACE_TARGETS.includes(target as SurfaceTarget)) return []
        const prefix = `${harnessFact(target as SurfaceTarget).outputs.skills}/`
        if (!entry.path.startsWith(prefix) || !/^[^/]+\/SKILL\.md$/.test(entry.path.slice(prefix.length))) return []
        return [{ target, path: entry.path, sha256: entry.sha256 }]
    })).sort((left, right) => compareCodeUnits(`${left.target}\0${left.path}`, `${right.target}\0${right.path}`))
    const installedSkillTargets = new Set(skillInventory.map(({ target }) => target))
    const installedSkillCosts = installedSkillInspection.costs.filter(({ target }) => installedSkillTargets.has(target))
    if (installedSkillCosts.length !== installedSkillTargets.size) {
        return refuse('SURFACE_INPUT_INVALID', 'a published skill target has no admitted standing-cost measurement', 'surfaces')
    }
    const surfaceHealth: GeneratedSurfaceHealthEvidence = {
        observedAt: prepared.producedAt,
        grants: projection.grants.map(grant => ({ ...grant })),
        nativeGrants,
        guideCosts: actualGuideCosts,
        skillCosts: installedSkillCosts,
        skillInventorySha256: sha256(JSON.stringify(skillInventory)),
        skillInventory,
        skills: installedSkillInspection.skills,
        skillCollectionSha256: skillInspection.collection.source.sha256,
    }
    const customSurfacePaths = new Set(customReceipts.flatMap(receipt => receipt.files.map(file => file.path)))
    const compactSurfacePaths = new Set(generated.files.map(file => file.path).filter(path => !customSurfacePaths.has(path)))
    const evaluator = asset(EVALUATOR_ASSET)
    const workApplication: WorkApplicationAuthorityRecord = {
        workEnvironment: prepared.workEnvironment,
        evaluator: {
            path: resolve(SURFACE_ROOT, evaluator.path),
            bytes: evaluator.bytes,
            sha256: evaluator.sha256,
            identity: evaluator.identity,
            restriction: 'instructed',
        },
        installedSkills: surfaceEntries.filter((entry): entry is Extract<SurfaceDesiredEntry, { kind: 'file' }> =>
            entry.kind === 'file' && /^(?:\.agents|\.claude|\.opencode)\/skills\/[^/]+\/SKILL\.md$/.test(entry.path))
            .map(({ path, sha256: digest }) => ({ path, sha256: digest }))
            .sort((left, right) => compareCodeUnits(left.path, right.path)),
        ...(browserAuthority ? { browser: browserAuthority } : {}),
        testing: { registry: testingRegistry },
    }
    const openCodeGrantRoots = projection.grants.filter(grant => grant.target === 'opencode')
        .map(grant => ({ slug: grant.slug, root: siblingRoots.get(grant.slug)! }))
    // The file's bytes become part of an OpenCode pattern: a wildcard would widen the grant and a
    // quote or backslash would change the JSON around it.
    const unsafeGrant = openCodeGrantRoots.find(row => row.root === undefined || /[*?"\\\x00-\x1f\x7f]/.test(row.root))
    if (unsafeGrant) return refuse('SURFACE_INPUT_INVALID',
        `the directory of sibling ${unsafeGrant.slug} contains *, ?, a quote, a backslash or a control character, which OpenCode would read as part of its access pattern; move the checkout to a plain path`,
        unsafeGrant.slug)
    return { ...prepared, guardHandler, openCodeGrantRoots, unapprovedMcpServers,
        surfaces: surfaceEntries, compactSurfacePaths, configuredHarnesses,
        activeSurfaceOverrides: merge.overrides, changedOverrideOriginals: merge.findings,
        surfaceSelftest,
        surfaceHealth,
        guideSources: {
            requests: guideRequests,
            observations: observedGuides.observations.map(row => ({ ...row }))
                .sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath)),
            missing: [...observedGuides.missing].sort(compareCodeUnits),
        },
        sourceEvidence: evidence, sourceRoots, customSources,
        adoptedSources: adopted.sources,
        ...(explicitNativeHooks ? { nativeHookPolicySource: explicitNativeHooks.source } : {}),
        surfaceAssets: assets.map(({ path, sha256: digest, identity }) => ({ path, sha256: digest, identity })),
        workApplication,
        warnings: [...rendered.warnings] }
}

const ADOPTED_HARNESS = Object.freeze({ '.claude/settings.json': 'claudecode', '.codex/config.toml': 'codexcli', '.codex/hooks.json': 'codexcli' } as const)

/**
 * Replace each adopted harness settings file in the rendered set with the merge of the team's
 * adopted copy and cockpit's rendering. The copy is read through the same anchored reader as every
 * other input and recorded, so publication refuses if it changes before the write.
 */
async function mergeAdoptedSurfaces(
    prepared: PreparedEnvironment,
    entries: readonly SurfaceDesiredEntry[],
    configuredHarnesses: readonly string[],
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<Readonly<{ entries: readonly SurfaceDesiredEntry[]; sources: readonly AdoptedSourceIdentity[] }> | RefusalOutcome> {
    const rows = prepared.registry.config.surfaces.adopted
    if (rows.length === 0) return { entries, sources: [] }
    const merged = [...entries]
    const sources: AdoptedSourceIdentity[] = []
    for (const row of rows) {
        const read = await readAnchoredFile(prepared.root, row.source, MAX_SURFACE_FILE_BYTES, prepared.node, adapters)
        if (read.kind !== 'complete') return refuse('SURFACE_ADOPTION_REFUSED',
            `the adopted copy of ${row.path} is ${read.kind === 'missing' ? 'missing' : 'not a bounded regular file'}; restore ${row.source} or remove its [[surfaces.adopted]] row`, row.source)
        let bytes: string
        try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) } catch {
            // undecodable bytes are malformed input the caller refuses.
            return refuse('SURFACE_ADOPTION_REFUSED', `the adopted copy ${row.source} is not UTF-8 text`, row.source)
        }
        const index = merged.findIndex(entry => entry.path === row.path)
        const current = index < 0 ? undefined : merged[index]!
        if (current && current.kind !== 'file') return refuse('SURFACE_ADOPTION_REFUSED', `cockpit does not render ${row.path} as a whole file`, row.path)
        const result = mergeAdoptedSurface(row.path, bytes, current?.bytes)
        if (result.kind !== 'complete') return refuse(result.diagnostic.code, result.diagnostic.message, result.diagnostic.target)
        const harness = ADOPTED_HARNESS[row.path]
        if (!configuredHarnesses.includes(harness)) return refuse('SURFACE_ADOPTION_REFUSED', `${row.path} belongs to ${harness}, which this cockpit does not configure`, row.path)
        const entry: SurfaceDesiredEntry = current
            ? { ...current, bytes: result.bytes, sha256: sha256(result.bytes) }
            : { kind: 'file', path: row.path, harnesses: [harness] as [string], scope: 'always', capability: 'instructed', writer: 'cockpit',
                schemaVersion: 1, ownership: 'whole-file', bytes: result.bytes, sha256: sha256(result.bytes) }
        if (index < 0) merged.push(entry)
        else merged[index] = entry
        sources.push({ path: row.source, sha256: read.sha256, identity: read.identity })
    }
    merged.sort((left, right) => compareCodeUnits(left.path, right.path))
    return { entries: merged, sources }
}

function mergedAdapters(overrides: Partial<GeneratedEnvironmentCommandAdapters>): GeneratedEnvironmentCommandAdapters {
    return { ...defaultAdapters, ...overrides }
}

async function inputSourcesCurrent(
    prepared: PreparedEnvironment,
    adapters: GeneratedEnvironmentCommandAdapters,
    deadline?: number,
): Promise<boolean> {
    try {
        if (deadline !== undefined && Date.now() >= deadline) return false
        if (prepared.runtimeCheckout && !await revalidateGeneratedCheckoutIdentity(prepared.runtimeCheckout)) return false
        if (!await siblingRootsCurrent(prepared.siblingRoots)) return false
        if (prepared.guardHandler) {
            const handler = prepared.guardHandler
            const root = await lstat(prepared.root)
            const config = await lstat(prepared.configPath)
            const module = await readAnchoredFile(dirname(handler.module), basename(handler.module), MAX_GENERATED_BYTES, prepared.node, adapters)
            if (String(root.dev) !== handler.rootDevice || String(root.ino) !== handler.rootInode
                || config.isSymbolicLink() || String(config.dev) !== handler.configDevice || String(config.ino) !== handler.configInode
                || module.kind !== 'complete' || module.sha256 !== handler.moduleSha256) return false
        }
        const target = await safePath(prepared.root, prepared.personaSource.path, false)
        if (!target) return false
        for (const expected of prepared.sourceRoots) {
            const status = await lstat(expected.root)
            if (!status.isDirectory() || status.isSymbolicLink() || status.dev !== expected.identity.dev || status.ino !== expected.identity.ino) return false
            if (deadline !== undefined && Date.now() >= deadline) return false
        }
        if (prepared.guideSources.requests.length > 0) {
            const current = await observeSiblingGuides({
                allowedRoots: [...new Set(prepared.guideSources.requests.map(row => row.root))],
                requests: prepared.guideSources.requests,
            })
            const observations = current.kind === 'complete'
                ? [...current.observations].sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath)) : []
            const missing = current.kind === 'complete' ? [...current.missing].sort(compareCodeUnits) : []
            if ((deadline !== undefined && Date.now() >= deadline) || current.kind !== 'complete'
                || missing.length !== prepared.guideSources.missing.length
                || missing.some((path, index) => path !== prepared.guideSources.missing[index])
                || observations.length !== prepared.guideSources.observations.length
                || observations.some((row, index) => {
                    const expected = prepared.guideSources.observations[index]
                    return !expected || row.slug !== expected.slug || row.sourcePath !== expected.sourcePath
                        || row.sourceEntryType !== expected.sourceEntryType || row.sourceLinkTarget !== expected.sourceLinkTarget
                        || row.contentPath !== expected.contentPath || row.content !== expected.content
                        || row.contentBytes !== expected.contentBytes || row.contentSha256 !== expected.contentSha256
                        || row.contentIdentity !== expected.contentIdentity
                })) return false
        }
        const mcpByRoot = new Map<string, Array<Extract<SurfaceInputEvidence, { kind: 'mcp' }>>>()
        for (const evidence of prepared.sourceEvidence) if (evidence.kind === 'mcp') {
            const group = mcpByRoot.get(evidence.root) ?? []
            group.push(evidence)
            mcpByRoot.set(evidence.root, group)
        }
        for (const [root, evidence] of mcpByRoot) {
            const reads = await readAnchoredBatches(root, evidence.map(row => ({
                path: row.path, maxBytes: MAX_GENERATED_BYTES, action: 'read-file' as const,
            })), prepared.node, adapters, deadline)
            if (!reads || reads.kind !== 'complete' || reads.results.length !== evidence.length || reads.results.some((read, index) => read.kind !== 'complete'
                || read.sha256 !== evidence[index]!.sha256 || sourceIdentity(read.identity) !== evidence[index]!.identity)) return false
            if (deadline !== undefined && Date.now() >= deadline) return false
        }
        const reads = await readAnchoredBatches(prepared.root, [
            { path: prepared.personaSource.path, maxBytes: MAX_GENERATED_BYTES, action: 'read-persona' as const },
            ...prepared.customSources.map(source => ({ path: source.path, maxBytes: source.maxBytes, action: 'read-file' as const })),
            ...(prepared.nativeHookPolicySource ? [{ path: prepared.nativeHookPolicySource.path,
                maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const }] : []),
            ...prepared.adoptedSources.map(source => ({ path: source.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const })),
            ...prepared.composeSources.map(source => ({ path: source.path, maxBytes: COMPOSE_SOURCE_BYTES, action: 'read-file' as const })),
        ], prepared.node, adapters, deadline)
        const adoptedOffset = prepared.customSources.length + 1 + (prepared.nativeHookPolicySource ? 1 : 0)
        const composeOffset = adoptedOffset + prepared.adoptedSources.length
        if ((deadline !== undefined && Date.now() >= deadline) || !reads || reads.kind !== 'complete'
            || reads.results.length !== composeOffset + prepared.composeSources.length) return false
        const source = reads.results[0]!
        const expected = prepared.personaSourceIdentity
        const localCurrent = source.kind === 'complete' && source.sha256 === prepared.personaSource.sha256
            && source.identity.root.dev === expected.root.dev && source.identity.root.ino === expected.root.ino
            && source.identity.file.dev === expected.file.dev && source.identity.file.ino === expected.file.ino
            && source.identity.chain.length === expected.chain.length
            && source.identity.chain.every((entry, index) => entry.dev === expected.chain[index]?.dev && entry.ino === expected.chain[index]?.ino)
            && prepared.customSources.every((custom, index) => {
                const read = reads.results[index + 1]!
                return read.kind === 'complete' && read.sha256 === custom.sha256
                    && sourceIdentity(read.identity) === sourceIdentity(custom.identity)
            })
            && (!prepared.nativeHookPolicySource || (() => {
                const read = reads.results[prepared.customSources.length + 1]!
                return read.kind === 'complete' && read.sha256 === prepared.nativeHookPolicySource.sha256
                    && sourceIdentity(read.identity) === sourceIdentity(prepared.nativeHookPolicySource.identity)
            })())
            && prepared.adoptedSources.every((adopted, index) => {
                const read = reads.results[adoptedOffset + index]!
                return read.kind === 'complete' && read.sha256 === adopted.sha256
                    && sourceIdentity(read.identity) === sourceIdentity(adopted.identity)
            })
            && prepared.composeSources.every((compose, index) => {
                const read = reads.results[composeOffset + index]!
                return read.kind === 'complete' && read.sha256 === compose.sha256
                    && sourceIdentity(read.identity) === sourceIdentity(compose.identity)
            })
        if (!localCurrent) return false
        const assetReads = prepared.surfaceAssets.length === 0
            ? { kind: 'complete' as const, results: [] }
            : await readAnchoredBatches(SURFACE_ROOT, prepared.surfaceAssets.map(asset => ({
            path: asset.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
        })), prepared.node, adapters, deadline)
        if (!assetReads || assetReads.kind !== 'complete' || assetReads.results.length !== prepared.surfaceAssets.length || assetReads.results.some((read, index) => read.kind !== 'complete'
            || read.sha256 !== prepared.surfaceAssets[index]!.sha256
            || sourceIdentity(read.identity) !== sourceIdentity(prepared.surfaceAssets[index]!.identity))) return false
        if (deadline !== undefined && Date.now() >= deadline) return false
        return true
    } catch { /* a failed re-observation means the inputs changed; the caller refuses. */ return false }
}

function publicationInputPath(root: string, path: string): string | undefined {
    const offset = relative(root, isAbsolute(path) ? path : resolve(root, path))
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
        ? offset : undefined
}

async function ownedInputOverlap(
    prepared: PreparedEnvironment,
    prior: readonly Readonly<{ path: string }>[],
): Promise<Readonly<{ kind: 'complete'; path?: string }> | Readonly<{ kind: 'invalid' }>> {
    const presentInputPaths = [
        prepared.configPath,
        resolve(prepared.root, prepared.personaSource.path),
        ...prepared.guideSources.observations.flatMap(observation => [observation.sourcePath, observation.contentPath]),
        ...prepared.sourceEvidence.filter((row): row is Extract<SurfaceInputEvidence, { kind: 'mcp' }> => row.kind === 'mcp')
            .map(evidence => resolve(evidence.root, evidence.path)),
        ...prepared.customSources.map(source => resolve(prepared.root, source.path)),
        ...(prepared.nativeHookPolicySource ? [resolve(prepared.root, prepared.nativeHookPolicySource.path)] : []),
        ...prepared.adoptedSources.map(source => resolve(prepared.root, source.path)),
    ]
    const requiredPresentPaths = new Set(presentInputPaths)
    const missingGuidePaths = new Set(prepared.guideSources.missing)
    const inputPaths = [...presentInputPaths, ...missingGuidePaths]
    const pathsUnderRoot = [...inputPaths, ...prior.map(row => resolve(prepared.root, row.path))]
        .map(path => publicationInputPath(prepared.root, path))
        .filter((path): path is string => path !== undefined)
    const directories = new Set([prepared.root])
    for (const path of pathsUnderRoot) {
        const segments = path.split(sep).slice(0, -1)
        let directory = prepared.root
        for (const segment of segments) {
            directory = resolve(directory, segment)
            directories.add(directory)
        }
    }
    if (directories.size > MAX_OWNED_FILES * 4 || constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined) {
        return { kind: 'invalid' }
    }
    type DirectoryWatch = Readonly<{
        path: string
        handle: Awaited<ReturnType<typeof open>>
        dev: bigint
        ino: bigint
        mtimeNs: bigint
        ctimeNs: bigint
    }>
    const handles: Array<Awaited<ReturnType<typeof open>>> = []
    const watches: DirectoryWatch[] = []
    let outcome: Readonly<{ kind: 'complete'; path?: string }> | Readonly<{ kind: 'invalid' }> = { kind: 'invalid' }
    let closeFailed = false
    const stable = async (watch: DirectoryWatch): Promise<boolean> => {
        const opened = await watch.handle.stat({ bigint: true })
        const named = await lstat(watch.path, { bigint: true })
        return opened.isDirectory() && named.isDirectory() && !named.isSymbolicLink()
            && opened.dev === watch.dev && opened.ino === watch.ino
            && opened.mtimeNs === watch.mtimeNs && opened.ctimeNs === watch.ctimeNs
            && named.dev === watch.dev && named.ino === watch.ino
            && named.mtimeNs === watch.mtimeNs && named.ctimeNs === watch.ctimeNs
    }
    try {
        for (const path of [...directories].sort(compareCodeUnits)) {
            let handle: Awaited<ReturnType<typeof open>>
            try {
                handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
            } catch (error) {
                if (hasErrorCode(error, 'ENOENT') && path !== prepared.root) continue
                throw error
            }
            handles.push(handle)
            const opened = await handle.stat({ bigint: true })
            const named = await lstat(path, { bigint: true })
            if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
                || opened.dev !== named.dev || opened.ino !== named.ino) throw new RefusalError('directory identity changed')
            if (path === prepared.root && (opened.dev !== BigInt(prepared.personaSourceIdentity.root.dev)
                || opened.ino !== BigInt(prepared.personaSourceIdentity.root.ino))) throw new RefusalError('publication root identity changed')
            watches.push({ path, handle, dev: opened.dev, ino: opened.ino,
                mtimeNs: opened.mtimeNs, ctimeNs: opened.ctimeNs })
        }
        if (!(await Promise.all(watches.map(stable))).every(Boolean)) throw new RefusalError('directory namespace changed')
        const exact = new Set<string>()
        const physical: Array<Readonly<{ dev: number; ino: number }>> = []
        for (const path of [...new Set(inputPaths)].sort(compareCodeUnits)) {
            const input = publicationInputPath(prepared.root, path)
            if (input) exact.add(input)
            let status: Awaited<ReturnType<typeof lstat>>
            try {
                status = await lstat(path)
            } catch (error) {
                if (hasErrorCode(error, 'ENOENT')
                    && missingGuidePaths.has(path) && !requiredPresentPaths.has(path)) continue
                throw error
            }
            physical.push({ dev: status.dev, ino: status.ino })
        }
        for (const row of [...prior].sort((left, right) => compareCodeUnits(left.path, right.path))) {
            if (exact.has(row.path)) {
                outcome = { kind: 'complete', path: row.path }
                break
            }
            const path = resolve(prepared.root, row.path)
            let status: Awaited<ReturnType<typeof lstat>>
            try {
                status = await lstat(path)
            } catch (error) {
                if (hasErrorCode(error, 'ENOENT')) continue
                throw error
            }
            if (physical.some(input => input.dev === status.dev && input.ino === status.ino)) {
                outcome = { kind: 'complete', path: row.path }
                break
            }
        }
        if (outcome.kind === 'invalid') outcome = { kind: 'complete' }
        if (!(await Promise.all(watches.map(stable))).every(Boolean)) outcome = { kind: 'invalid' }
    } catch {
        // an unobservable directory is reported as an invalid read.
        outcome = { kind: 'invalid' }
    } finally {
        for (const handle of handles.reverse()) try { await handle.close() } catch { /* an unobservable directory is reported as an invalid read. */ closeFailed = true }
    }
    return closeFailed ? { kind: 'invalid' } : outcome
}

async function surfaceObservationMaxBytes(root: string, path: string): Promise<number | undefined> {
    const target = confined(root, path)
    if (!target) return undefined
    try {
        const status = await lstat(target)
        if (!status.isFile() || status.isSymbolicLink()) return 1
        if (!Number.isSafeInteger(status.size) || status.size < 0) return undefined
        return Math.min(MAX_GENERATED_BYTES, Math.max(1, status.size))
    } catch (error) {
        return hasErrorCode(error, 'ENOENT') ? 1 : undefined
    }
}

async function observeSurfaceState(
    prepared: PreparedEnvironment,
    prior: readonly SurfacePriorOwnedEntry[],
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<{ observed: readonly SurfaceObservedEntry[]; raw: ReadonlyMap<string, AnchoredEntry>; opaque: ReadonlySet<string> } | undefined> {
    const paths = new Set([...prepared.surfaces.map(row => row.path), ...prior.map(row => row.path)])
    if (prepared.surfaces.some(row => row.path === 'opencode.jsonc')) paths.add('opencode.json')
    const raw = new Map<string, AnchoredEntry>()
    const observed: SurfaceObservedEntry[] = []
    const opaque = new Set<string>()
    const orderedPaths = [...paths].sort(compareCodeUnits)
    const maxBytes = await Promise.all(orderedPaths.map(path => surfaceObservationMaxBytes(prepared.root, path)))
    if (maxBytes.some(limit => limit === undefined)) return undefined
    const entries = await readAnchoredBatches(prepared.root, orderedPaths.map((path, index) => ({
        path, maxBytes: maxBytes[index]!, action: 'read-entry' as const,
    })), prepared.node, adapters)
    if (!entries || entries.kind !== 'complete' || entries.results.length !== orderedPaths.length) return undefined
    for (const [index, path] of orderedPaths.entries()) {
        const entry = entries.results[index]!
        if (entry.kind === 'invalid') return undefined
        if (entry.kind === 'complete') return undefined
        raw.set(path, entry)
        if (entry.kind === 'missing') observed.push({ path, kind: 'missing' })
        else if (entry.kind === 'file') {
            let bytes: string
            try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes) } catch {
                // undecodable bytes make the path opaque, never owned.
                opaque.add(path)
                continue
            }
            observed.push({ path, kind: 'file', bytes, sha256: entry.sha256, identity: sourceIdentity(entry.identity) })
        } else if (entry.kind === 'symlink') observed.push({ path, kind: 'symlink', target: entry.target, identity: JSON.stringify(entry.identity) })
        else observed.push({ path, kind: 'other', identity: 'other' })
    }
    return { observed, raw, opaque }
}

async function classifyOwnedState(
    prepared: PreparedEnvironment,
    manifest: OwnershipManifest | undefined,
    raw: ReadonlyMap<string, AnchoredBatchReadResult>,
): Promise<GeneratedPathClassificationResult> {
    const current = generatedPathFacts(prepared, 'declared-before-sync')
    if (current.kind !== 'complete') return current
    const historical = manifest ? projectGeneratedPathFacts(manifest, { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath }, []) : { kind: 'complete' as const, facts: [] }
    if (historical.kind !== 'complete') return historical
    const previous = new Map(historical.facts.map(fact => [fact.path, fact]))
    const desired = new Map(current.facts.map(fact => [fact.path, fact]))
    const facts: GeneratedPathFact[] = []
    const observations: Array<Record<string, unknown>> = []
    for (const [path, observed] of raw) {
        const fact = observed.kind === 'missing'
            ? desired.get(path) ?? previous.get(path) : previous.get(path) ?? desired.get(path)
        if (!fact) continue
        facts.push(fact)
        if (observed.kind === 'file') observations.push({ path, kind: 'file', bytes: observed.bytes, confinement: 'confined', identity: sourceIdentity(observed.identity) })
        else observations.push({ path, kind: observed.kind, confinement: observed.kind === 'missing' ? 'confined' : 'unknown' })
    }
    return classifyGeneratedPaths(facts, observations)
}

function planObservedSurfaces(
    prepared: PreparedEnvironment,
    priorOwned: readonly SurfacePriorOwnedEntry[],
    state: NonNullable<Awaited<ReturnType<typeof observeSurfaceState>>>,
): SurfaceChangePlanResult {
    const plan = planSurfaceChanges({ configuredHarnesses: [...new Set([...prepared.configuredHarnesses, ...priorOwned.flatMap(row => row.harnesses)])].sort(),
        desired: prepared.surfaces.filter(row => !state.opaque.has(row.path)),
        priorOwned: priorOwned.filter(row => !state.opaque.has(row.path)), observed: state.observed })
    if (plan.kind !== 'complete') return plan
    const extra: SurfaceChange[] = []
    for (const path of state.opaque) {
        const prior = priorOwned.find(row => row.path === path)
        const desired = prepared.surfaces.find(row => row.path === path)
        const raw = state.raw.get(path)
        if (!prior || prior.kind !== 'file' || raw?.kind !== 'file' || prior.sha256 !== raw.sha256
            || desired && desired.kind !== 'file') return { kind: 'refusal', diagnostic: { code: 'SURFACE_STATE_CONFLICT', message: 'opaque surface bytes do not match authenticated whole-file ownership', target: path } }
        extra.push(desired ? { kind: 'write', path, desired } : { kind: 'remove', path, priorOwned: prior })
    }
    const actions = [...plan.actions, ...extra].sort((a, b) => (a.kind === 'write' ? 0 : 1) - (b.kind === 'write' ? 0 : 1) || compareCodeUnits(a.path, b.path))
    return { kind: 'complete', actions }
}

/** A hand edit to a merged adopted file belongs in its adopted copy; say so where the conflict is reported. */
function surfacePlanRefusal(prepared: PreparedEnvironment, diagnostic: SurfaceDiagnostic, unfinishedInit?: UnfinishedInit): RefusalOutcome {
    const adopted = diagnostic.code === 'SURFACE_STATE_CONFLICT'
        ? prepared.registry.config.surfaces.adopted.find(row => row.path === diagnostic.target) : undefined
    // Plain sync met a setup file an unfinished init published and can no longer vouch for; the
    // person needs to hear about that init, not only that the file is unrecorded.
    if (diagnostic.code === 'SURFACE_STATE_CONFLICT' && unfinishedInit && !unfinishedInit.surfaces
        && diagnostic.target !== undefined && unfinishedInit.published.includes(diagnostic.target)) {
        return refuse(diagnostic.code, `${diagnostic.message}; an unfinished init for this root (--target ${unfinishedInit.target}) published it, and it no longer holds the bytes that init recorded or the installed cockpit package changed since`,
            diagnostic.target, `resume that init with ${initCommand({ root: unfinishedInit.root, target: unfinishedInit.target })} and the options you started it with, which shows its current preview; or ask the person who ran init before you remove cockpit.toml and the files it published so init starts again`)
    }
    return adopted
        ? refuse(diagnostic.code, `${diagnostic.message}; ${adopted.path} is merged from ${adopted.source}`, diagnostic.target,
            `make the change in ${adopted.source}, then ask the person who owns the cockpit before you delete ${adopted.path}, and run npx --no cockpit sync --config <your cockpit.toml>`)
        : refuse(diagnostic.code, diagnostic.message, diagnostic.target, diagnostic.fix)
}

function surfaceMutations(
    actions: readonly SurfaceChange[],
    raw: ReadonlyMap<string, AnchoredEntry>,
    compactSurfacePaths: ReadonlySet<string>,
): readonly PublicationMutation[] | undefined {
    const compactAnchorFor = (path: string): string | undefined => {
        return SURFACE_PUBLICATION_ANCHORS.find(anchor => path.startsWith(`${anchor}/`))
    }
    const result: PublicationMutation[] = []
    for (const action of actions) {
        if (action.kind === 'already-absent') continue
        const current = raw.get(action.path) ?? { kind: 'missing' as const }
        const expected = expectedState(current)
        if (!expected) return undefined
        if (action.kind === 'write') {
            const compactAnchor = compactSurfacePaths.has(action.path) ? compactAnchorFor(action.path) : undefined
            const bytes = action.desired.kind === 'file' ? action.desired.bytes : action.postimage
            if (bytes === undefined) return undefined
            result.push({ path: action.path, phase: 'desired', operation: 'write-file', bytes, sha256: sha256(bytes), expected,
                ...(compactAnchor ? { compactAnchor } : {}) })
        } else if (action.postimage !== undefined) result.push({ path: action.path, phase: 'stale', operation: 'write-file', bytes: action.postimage,
            sha256: sha256(action.postimage), expected })
        else result.push({ path: action.path, phase: 'stale', operation: 'remove-file', expected })
    }
    return result
}

async function environmentMutations(
    prepared: PreparedEnvironment,
    manifest: OwnershipManifest | undefined,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<Readonly<{ kind: 'complete'; mutations: readonly PublicationMutation[] }> | Readonly<{ kind: 'invalid'; path: string }>> {
    const prior = manifest?.entries ?? []
    const surfacePaths = new Set(prepared.surfaces.map(row => row.path))
    const priorEnvironment = new Map(prior.filter((row): row is EnvironmentOwnershipEntry => !('harnesses' in row) && !surfacePaths.has(row.path)).map(row => [row.path, row]))
    const desired = new Map(prepared.owned.map(row => [row.path, row]))
    const paths = [...new Set([...priorEnvironment.keys(), ...desired.keys()])].sort(compareCodeUnits)
    const mutations: PublicationMutation[] = []
    const entries = await readAnchoredBatches(prepared.root, paths.map(path => ({
        path, maxBytes: MAX_GENERATED_BYTES, action: 'read-entry' as const,
    })), prepared.node, adapters)
    if (!entries) return { kind: 'invalid', path: paths[0] ?? 'generated-environment' }
    if (entries.kind === 'invalid') return { kind: 'invalid', path: paths[entries.index] ?? paths[0] ?? 'generated-environment' }
    if (entries.results.length !== paths.length) return { kind: 'invalid', path: paths[0] ?? 'generated-environment' }
    const classified = await classifyOwnedState(prepared, manifest, new Map(paths.map((path, index) => [path, entries.results[index]!])))
    if (classified.kind !== 'complete') return { kind: 'invalid', path: classified.diagnostic.target ?? 'generated-environment' }
    const unknown = classified.paths.find(row => row.state === 'unknown')
    if (unknown) return { kind: 'invalid', path: unknown.fact.path }
    for (const [index, path] of paths.entries()) {
        const current = entries.results[index]!
        if (current.kind === 'complete') return { kind: 'invalid', path }
        const expected = expectedState(current)
        if (!expected) return { kind: 'invalid', path }
        const owned = priorEnvironment.get(path)
        const next = desired.get(path)
        if (current.kind !== 'missing' && (!owned || current.kind !== 'file'
            || current.sha256 !== owned.sha256 && next?.sha256 !== owned.sha256)) {
            return { kind: 'invalid', path }
        }
        if (next) {
            if (current.kind === 'file' && current.sha256 === next.sha256) continue
            mutations.push({ path, phase: 'desired', operation: 'write-file', bytes: next.bytes, sha256: next.sha256, expected })
        } else if (current.kind === 'file') mutations.push({ path, phase: 'stale', operation: 'remove-file', expected })
    }
    return { kind: 'complete', mutations }
}

async function preparePublication(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
    seed?: PreparedEnvironment,
    knownOwnership?: OwnershipState,
): Promise<RefusalOutcome | Readonly<{
    prepared: PreparedEnvironment; ownership: OwnershipState; plan: PublicationPlan
}> | Readonly<{
    prepared: PreparedEnvironment; ownership: OwnershipState; refusal: RefusalOutcome
}>> {
    const request = syncCommandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const adapters = mergedAdapters(adapterOverrides)
    const base = seed ?? await prepare({ configPath: request.configPath }, adapters)
    if ('status' in base) return base
    const ownership = knownOwnership ?? await readOwnership(base, adapters)
    if (ownership.kind === 'unsupported') return refuse(
        'GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED', `generated ownership format ${ownership.format} is not supported`, OWNERSHIP_PATH,
    )
    if (ownership.kind === 'invalid') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata is malformed or unsafe', OWNERSHIP_PATH,
        'restore the last trusted ownership metadata before syncing',
    )
    if (ownership.kind === 'complete' && ownership.manifest.cockpitId !== base.cockpitId) {
        const recorded = await renamedStackRefusal(base)
        if (recorded) return recorded
    }
    const unfinishedInit = ownership.kind === 'missing' && !request.bootstrapState
        ? await unfinishedInitSurfaces(base.root, base.node, adapters) : undefined
    const adoptedBootstrap = ownership.kind !== 'missing' ? undefined : request.bootstrapState
        ? await authenticatedBootstrapPriorSurfaces(base.root, request.bootstrapState, base.node, adapters)
        : unfinishedInit?.surfaces
    if (ownership.kind === 'missing' && request.bootstrapState && !adoptedBootstrap) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'the setup skill files init published no longer hold the bytes it recorded, or the installed cockpit package changed since init published them, so sync cannot take them over as cockpit\'s own', 'bootstrap',
        `if the cockpit package was upgraded, run ${initCommand({ args: '--json' })} and accept its fresh preview; otherwise restore the setup skill files init published (its --json preview lists them under result.files), or ask the person who ran init before you remove cockpit.toml and those files so init starts again`,
    )
    if (ownership.kind !== 'missing' && request.bootstrapState) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap adoption is only valid before the first ownership manifest', 'bootstrap',
    )
    if (ownership.kind === 'missing' && await expectedOutputExists(base)) return refuse(
        'GENERATED_OWNERSHIP_MISSING', 'generated outputs exist without durable ownership metadata', OWNERSHIP_PATH,
        'restore the last trusted ownership metadata before syncing',
    )
    const current = await readAnchoredEntry(base.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, base.node, adapters)
    if (ownership.kind === 'missing' ? current.kind !== 'missing'
        : current.kind !== 'file' || current.sha256 !== ownership.sha256
            || sourceIdentity(current.identity) !== sourceIdentity(ownership.identity)) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata changed after observation', OWNERSHIP_PATH,
    )
    const priorEntries = ownership.kind === 'complete' ? ownership.manifest.entries : []
    const priorSurfaces = [...priorEntries.filter((row): row is SurfacePriorOwnedEntry => 'harnesses' in row), ...(adoptedBootstrap ?? [])]
        .sort((left, right) => compareCodeUnits(left.path, right.path))
    const prepared = await prepareSurfaces(base, priorSurfaces, adapters, ownership.kind === 'complete' ? ownership.manifest : undefined)
    if ('status' in prepared) return prepared
    const ownedInput = await ownedInputOverlap(prepared, priorEntries)
    if (ownedInput.kind === 'invalid') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'authenticated input identity could not be compared with generated ownership metadata', OWNERSHIP_PATH,
        'restore the last trusted ownership metadata before syncing',
    )
    if (ownedInput.path) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata overlaps an authenticated input', ownedInput.path,
        'restore the last trusted ownership metadata before syncing',
    )
    const surfaceState = await observeSurfaceState(prepared, priorSurfaces, adapters)
    if (!surfaceState) return refuse('SURFACE_STATE_CONFLICT', 'surface state could not be observed safely', 'surfaces')
    const classified = await classifyOwnedState(prepared, ownership.kind === 'complete' ? ownership.manifest : undefined, surfaceState.raw)
    if (classified.kind !== 'complete') return refuse(classified.diagnostic.code, classified.diagnostic.message, classified.diagnostic.target)
    const unknown = classified.paths.find(row => row.state === 'unknown')
    if (unknown) return refuse('SURFACE_STATE_CONFLICT', 'owned surface identity or confinement is unknown', unknown.fact.path)
    const effectivePriorSurfaces = priorSurfaces
    const environment = await environmentMutations(prepared, ownership.kind === 'complete' ? ownership.manifest : undefined, adapters)
    if (environment.kind === 'invalid') return { prepared, ownership, refusal: refuse(
        'GENERATED_STALE_ARTIFACT_DRIFT', 'a generated whole-file path is unmanaged, changed, or unsafe', environment.path,
    ) }
    const plan = planObservedSurfaces(prepared, effectivePriorSurfaces, surfaceState)
    if (plan.kind !== 'complete') return surfacePlanRefusal(prepared, plan.diagnostic, unfinishedInit)
    const surface = surfaceMutations(plan.actions, surfaceState.raw, prepared.compactSurfacePaths)
    if (!surface) return refuse('SURFACE_STATE_CONFLICT', 'surface change plan could not be admitted', 'surfaces')
    const all = [...environment.mutations, ...surface]
    if (new Set(all.map(row => row.path)).size !== all.length) return refuse('SURFACE_PATH_CONFLICT', 'generated output estates overlap', 'generated-environment')
    const publication = await admitPublicationPlan({
        authority: { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath },
        generation: prepared.generation,
        sourceSha256: prepared.sourceSha256,
        rootIdentity: prepared.personaSourceIdentity.root,
        node: prepared.node,
        mode: 'sync',
        ledgerExpected: ownership.kind === 'missing' ? { kind: 'missing' }
            : { kind: 'file', sha256: ownership.sha256, identity: ownership.identity.file },
        nextLedgerBytes: encodeOwnershipManifest(prepared).bytes,
        mutations: all,
        surfaceActions: plan.actions,
    }, adapters)
    if (publication.kind === 'refusal') return { prepared, ownership, refusal: publication }
    return { prepared, ownership, plan: publication.plan }
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
}

interface RepairRecord {
    readonly prepared: PreparedEnvironment
    readonly plan: PublicationPlan
    readonly adapters: GeneratedEnvironmentCommandAdapters
}
const issuedRepairs = new WeakMap<GeneratedEnvironmentRepairAuthority, RepairRecord>()

function issueRepairAuthority(record: RepairRecord): GeneratedEnvironmentRepairAuthority {
    const authority: GeneratedEnvironmentRepairAuthority = { kind: 'generated-environment-repair' }
    issuedRepairs.set(authority, record)
    return authority
}

export async function prepareGeneratedEnvironmentCurrentness(
    input: GeneratedEnvironmentCommandInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<GeneratedEnvironmentCurrentness> {
    const adapters = mergedAdapters(adapterOverrides)
    const base = await prepare(input, adapters)
    const ownership = 'status' in base ? undefined : await readOwnership(base, adapters)
    const publication = 'status' in base ? base : await preparePublication(input, adapters, base, ownership)
    const prepared = 'prepared' in publication ? publication.prepared : undefined
    const outcome = 'status' in publication ? publication : await checkCanonicalGeneratedEnvironment(input, prepared, adapters)
    const authority = prepared && 'plan' in publication
        ? issueRepairAuthority({ prepared, plan: publication.plan, adapters }) : undefined
    return {
        outcome,
        changes: 'plan' in publication ? publication.plan.changes : [],
        storedProducer: ownership?.kind === 'complete' ? ownership.manifest.producer : null,
        currentProducer: { package: installedPackageMetadata.name, version: installedPackageMetadata.version,
            sourceRevision: installedPackageMetadata.cockpitSourceRevision },
        fixContext: { resolvedConfigPath: prepared?.configPath ?? null,
            generatedTargets: prepared ? [...prepared.owned, ...prepared.surfaces].map(row => row.path) : [] },
        ...(authority ? { repairAuthority: authority } : {}),
        ...('status' in publication ? { repairRefusal: publication }
            : 'refusal' in publication ? { repairRefusal: publication.refusal } : {}),
    }
}

async function prepareGeneratedEnvironmentSync(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters>,
    metadataChanges: readonly TeamMetadataChange[] = [],
): Promise<RefusalOutcome | Readonly<{ kind: 'complete'; authority: GeneratedEnvironmentRepairAuthority; dryRun: boolean }>> {
    const request = syncCommandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const adapters = mergedAdapters(adapterOverrides)
    const publication = await preparePublication(request, adapters)
    if ('status' in publication) return publication
    if ('refusal' in publication) return publication.refusal
    if (metadataChanges.length > 0) {
        const generatedPaths = [...new Set([
            ...publication.prepared.owned.map(row => row.path),
            ...publication.prepared.surfaces.map(row => row.path),
            ...(publication.ownership.kind === 'complete' ? publication.ownership.manifest.entries.map(row => row.path) : []),
        ])]
        const destination = metadataChanges.find(change => generatedPaths.some(path => path === change.path || path.startsWith(`${change.path}/`))
            || !portablePublicationPaths([...generatedPaths, change.path]))
        if (destination) return refuse('TEAM_METADATA_UNAVAILABLE',
            'a pending team metadata write overlaps a generated destination; move the generated output to a separate path, then run npx --no cockpit sync --config <your cockpit.toml> again', destination.path)
        const overlap = await ownedInputOverlap(publication.prepared, metadataChanges)
        if (overlap.kind === 'invalid' || overlap.path) return refuse('TEAM_METADATA_UNAVAILABLE',
            'pending team metadata writes overlap an authenticated input or its identity could not be checked; move the input to a separate file, update its declaration, then run npx --no cockpit sync --config <your cockpit.toml> again',
            overlap.kind === 'complete' ? overlap.path : 'team-metadata')
    }
    const authority = issueRepairAuthority({ prepared: publication.prepared, plan: publication.plan, adapters })
    return { kind: 'complete', authority, dryRun: request.dryRun === true }
}

export async function syncGeneratedEnvironment(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<GeneratedEnvironmentCommandOutcome> {
    const prepared = await prepareGeneratedEnvironmentSync(input, adapterOverrides)
    return prepared.kind === 'refusal' ? prepared : applyGeneratedEnvironmentRepair(prepared.authority, { dryRun: prepared.dryRun })
}

export async function syncTeamGeneratedEnvironment(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<GeneratedEnvironmentCommandOutcome> {
    const request = syncCommandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const metadata = await prepareTeamMetadata(request.configPath)
    if (metadata.kind === 'refusal') return refuse(metadata.code, metadata.message, metadata.target, metadata.fix)
    const prepared = await prepareGeneratedEnvironmentSync(request, adapterOverrides, metadata.authority.changes)
    if (prepared.kind === 'refusal') return prepared
    if (!prepared.dryRun) {
        const record = issuedRepairs.get(prepared.authority)!
        const approved = await authorizePublicationPlan(record.plan, record.adapters)
        if (approved !== true) return approved
        const applied = await applyTeamMetadata(metadata.authority)
        if (applied.kind === 'refusal') return refuse(applied.code, applied.message, applied.target)
    }
    const outcome = await applyGeneratedEnvironmentRepair(prepared.authority, { dryRun: prepared.dryRun })
    return outcome.kind === 'refusal' ? outcome : { ...outcome,
        result: { ...outcome.result, changes: [...metadata.authority.changes, ...outcome.result.changes] } }
}

export async function applyGeneratedEnvironmentRepair(
    authority: GeneratedEnvironmentRepairAuthority,
    options: Readonly<{ dryRun?: boolean }> = {},
): Promise<GeneratedEnvironmentCommandOutcome> {
    const settings = ownRecord(options)
    if (!settings || Object.keys(settings).some(key => key !== 'dryRun')
        || settings.dryRun !== undefined && typeof settings.dryRun !== 'boolean') return refuse(
        'GENERATED_INPUT_INVALID', 'repair publication options are invalid', 'generated-environment',
    )
    const record = issuedRepairs.get(authority)
    if (!record) return refuse('GENERATED_PUBLICATION_FAILED', 'repair authority is unknown or already consumed', 'generated-environment')
    issuedRepairs.delete(authority)
    const { prepared, adapters } = record
    const changedOriginal = prepared.changedOverrideOriginals[0]
    if (changedOriginal && settings.dryRun !== true) return overrideChangedRefusal(changedOriginal)
    const outcome = await runPublicationPlan(record.plan, {
        ...adapters,
        dryRun: settings.dryRun === true,
        revalidate: async (deadline, stage) => {
            const source = await adapters.observeSource(prepared.configPath)
            if (source.state !== 'available' || source.sha256 !== prepared.sourceSha256) return refuse('GENERATED_SOURCE_CHANGED', 'the configuration changed before generated files could be published', 'generated-environment')
            if (stage === 'after-publish') {
                const checked = await checkCanonicalGeneratedEnvironment({ configPath: prepared.configPath }, prepared, adapters)
                return checked.kind === 'complete' ? true : checked
            }
            if (!await inputSourcesCurrent(prepared, adapters, deadline)) return refuse('GENERATED_SOURCE_CHANGED', 'a generated input changed before publication', stage === 'before-stage' ? prepared.personaSource.path : 'generated-environment')
            return true
        },
    })
    if (outcome.kind === 'refusal') return outcome
    if (prepared.guardHandler && settings.dryRun !== true) {
        const local = await writeGuardLocalIdentity(prepared.root, prepared.guardHandler)
        if (local.kind === 'refusal') return refuse('GENERATED_PUBLICATION_FAILED',
            `the committed guard files were published, but ${local.message}; the guard refuses every agent tool call until it exists`,
            GUARD_LOCAL_PATHS.identity, 'fix the path, then run `npx --no cockpit sync --config <your cockpit.toml>` again in a terminal')
    }
    if (prepared.openCodeGrantRoots.length > 0 && settings.dryRun !== true) {
        const local = await writeCockpitLocalFiles(prepared.root, prepared.openCodeGrantRoots.map(row => ({
            name: basename(openCodeGrantFile(row.slug)), bytes: row.root })))
        if (local.kind === 'refusal') return refuse('GENERATED_PUBLICATION_FAILED',
            `the committed OpenCode settings were published, but ${local.message}; OpenCode refuses to start until it exists`,
            GUARD_LOCAL_PATHS.directory, 'fix the path, then run `npx --no cockpit sync --config <your cockpit.toml>` again in a terminal')
    }
    return complete('sync', prepared, settings.dryRun === true, outcome.changes, settings.dryRun ? outcome.staleRemoval : undefined)
}

// Each copied guide carries a marker naming its sibling, path and digest, so the guides whose copy in
// the AGENTS.md on disk differs from the one sync would write can be named rather than the file alone.
function staleSiblingGuides(prepared: PreparedEnvironment, observed: readonly SurfaceObservedEntry[]): readonly string[] {
    const desired = prepared.surfaces.find(entry => entry.path === 'AGENTS.md')
    const current = observed.find(entry => entry.path === 'AGENTS.md')
    const markers = (text: string) => new Map([...text.matchAll(SIBLING_GUIDE_MARKER)].map(match => [`${match[1]}/${match[2]}`, match[3]]))
    const want = markers(desired?.kind === 'shared-region' && desired.region.format === 'markdown-delimited' ? desired.region.bytes : '')
    const have = markers(current?.kind === 'file' ? current.bytes : '')
    return [...new Set([...want.keys(), ...have.keys()])].filter(key => want.get(key) !== have.get(key)).sort(compareCodeUnits)
}

async function checkCanonicalGeneratedEnvironment(
    input: GeneratedEnvironmentCommandInput,
    seed?: PreparedEnvironment,
    adapters: GeneratedEnvironmentCommandAdapters = defaultAdapters,
): Promise<GeneratedEnvironmentCommandOutcome> {
    const base = seed ?? await prepare(input, adapters)
    if ('status' in base) return base
    const ownership = await readOwnership(base, adapters)
    if (ownership.kind === 'unsupported') return refuse(
        'GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED', `generated ownership format ${ownership.format} is not supported`, OWNERSHIP_PATH,
    )
    if (ownership.kind !== 'complete') return refuse(
        ownership.kind === 'missing' ? 'GENERATED_OWNERSHIP_MISSING' : 'GENERATED_OWNERSHIP_INVALID',
        'durable generated ownership metadata is missing or invalid', OWNERSHIP_PATH,
        'restore trusted ownership metadata or run npx --no cockpit sync --config <your cockpit.toml>',
    )
    const priorSurfaces = ownership.manifest.entries.filter((row): row is SurfacePriorOwnedEntry => 'harnesses' in row)
    const prepared = seed?.surfaceSelftest ? seed : await prepareSurfaces(base, priorSurfaces, adapters, ownership.manifest)
    if ('status' in prepared) return prepared
    if (prepared.changedOverrideOriginals[0]) return overrideChangedRefusal(prepared.changedOverrideOriginals[0])
    const ownedInput = await ownedInputOverlap(prepared, ownership.manifest.entries)
    if (ownedInput.kind === 'invalid') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'authenticated input identity could not be compared with generated ownership metadata', OWNERSHIP_PATH,
        'restore trusted ownership metadata or run npx --no cockpit sync --config <your cockpit.toml>',
    )
    if (ownedInput.path) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata overlaps an authenticated input', ownedInput.path,
        'restore trusted ownership metadata or run npx --no cockpit sync --config <your cockpit.toml>',
    )
    const surfaceState = await observeSurfaceState(prepared, priorSurfaces, adapters)
    if (!surfaceState) return refuse('SURFACE_STATE_CONFLICT', 'surface state could not be observed safely', 'surfaces')
    const classified = await classifyOwnedState(prepared, ownership.manifest, surfaceState.raw)
    if (classified.kind !== 'complete') return refuse(classified.diagnostic.code, classified.diagnostic.message, classified.diagnostic.target)
    const unknown = classified.paths.find(row => row.state === 'unknown')
    if (unknown) return refuse('SURFACE_STATE_CONFLICT', 'owned surface identity or confinement is unknown', unknown.fact.path)
    const effectivePriorSurfaces = priorSurfaces
    const surfacePaths = new Set(prepared.surfaces.map(row => row.path))
    const staleEnvironment = ownership.manifest.entries.filter(row => !('harnesses' in row) && !surfacePaths.has(row.path)
        && !prepared.owned.some(file => file.path === row.path))
    if (staleEnvironment.length > 0) return refuse('GENERATED_STALE_ARTIFACT', 'a formerly owned generated artifact remains in durable ownership metadata', staleEnvironment[0]!.path,
        'a person runs npx --no cockpit sync --config <your cockpit.toml> --interactive in a terminal and approves the stale-removal digest it shows')
    const required = generatedPathFacts(prepared, 'required-after-sync')
    if (required.kind !== 'complete') return refuse(required.diagnostic.code, required.diagnostic.message, required.diagnostic.target)
    const canonicalReads = await readAnchoredBatches(prepared.root, prepared.generated.map(file => ({
        path: file.path, maxBytes: MAX_GENERATED_BYTES, action: 'read-file' as const,
    })), prepared.node, adapters)
    // An indexed refusal omits the prefix receipts. Reobserve only that prefix to retain
    // first-failure ordering; the failed row remains fatal even if a later read could succeed.
    for (const [index, file] of prepared.generated.entries()) {
        try {
            const read = canonicalReads?.kind === 'complete' ? canonicalReads.results[index]
                : canonicalReads?.kind === 'invalid' && index < canonicalReads.index
                    ? await readAnchoredFile(prepared.root, file.path, MAX_GENERATED_BYTES, prepared.node, adapters)
                    : undefined
            if (!read || read.kind !== 'complete') throw new RefusalError('generated artifact unavailable')
            const fact = required.facts.find(fact => fact.path === file.path)!
            const classification = classifyGeneratedPaths([fact], [{ path: file.path, kind: 'file', bytes: read.bytes,
                confinement: 'confined', identity: sourceIdentity(read.identity) }])
            if (classification.kind !== 'complete' || classification.paths[0]?.state === 'unknown') return refuse(
                'GENERATED_ARTIFACT_MISSING', 'owned generated artifact could not be classified safely', file.path, 'run npx --no cockpit sync --config <your cockpit.toml>',
            )
            if (classification.paths[0]?.state !== 'unchanged') return refuse(
                'GENERATED_ARTIFACT_DRIFT', 'owned generated artifact differs from canonical bytes', file.path, 'run npx --no cockpit sync --config <your cockpit.toml>',
            )
        } catch (error) {
            return refuse('GENERATED_ARTIFACT_MISSING', `owned generated artifact became unreadable: ${errorCause(error)}`, file.path, 'run npx --no cockpit sync --config <your cockpit.toml>')
        }
    }
    const comparison = planObservedSurfaces(prepared, effectivePriorSurfaces, surfaceState)
    if (comparison.kind !== 'complete') return surfacePlanRefusal(prepared, comparison.diagnostic)
    const drift = comparison.actions.map(action => action.path)
    // Removing a formerly owned path is plain sync's to do only where [autonomy] stale_delete is agent;
    // otherwise it needs a person's approval of its exact digest, so send the reader to the one command that can.
    const stale = comparison.actions.find(action => action.kind === 'remove')
    if (stale) return prepared.workEnvironment.policy.autonomy.stale_delete === 'agent'
        ? refuse('GENERATED_ARTIFACT_DRIFT', 'a formerly generated path is still on disk and in the ownership record', stale.path, 'run npx --no cockpit sync --config <your cockpit.toml>')
        : refuse('GENERATED_ARTIFACT_DRIFT', 'a formerly generated path is still on disk and in the ownership record', stale.path,
            'a person runs npx --no cockpit sync --config <your cockpit.toml> --interactive in a terminal and approves the stale-removal digest it shows')
    const staleGuides = drift.includes('AGENTS.md') ? staleSiblingGuides(prepared, surfaceState.observed) : []
    if (staleGuides.length > 0) return refuse('GENERATED_ARTIFACT_DRIFT',
        `AGENTS.md holds an out-of-date copy of ${staleGuides.join(', ')}: the guide changed in its sibling, or the declared guides changed, since the last sync`,
        'AGENTS.md', 'run npx --no cockpit sync --config <your cockpit.toml>, then commit AGENTS.md together with the guide change')
    if (drift.length > 0) return refuse('GENERATED_ARTIFACT_DRIFT', 'owned surface state differs from the canonical model', drift[0]!, 'run npx --no cockpit sync --config <your cockpit.toml>')
    if (ownership.bytes !== encodeOwnershipManifest(prepared).bytes) return refuse(
        'GENERATED_OWNERSHIP_DRIFT', 'generated ownership metadata differs from the current canonical manifest', OWNERSHIP_PATH,
        'run npx --no cockpit sync --config <your cockpit.toml>',
    )
    const source = await observeConfigSource(prepared.configPath)
    if (source.state !== 'available' || source.sha256 !== prepared.sourceSha256
        || !await inputSourcesCurrent(prepared, adapters)) {
        return refuse('GENERATED_SOURCE_CHANGED', 'a generated input changed during generated environment checking', 'generated-environment')
    }
    return complete('check', prepared)
}

// A cockpit running its own Compose files owns that topology, so check reads it as Compose resolves
// it and reports what would break parallel stacks.
async function composeTopologyDiagnostics(
    configPath: string,
    sourceSha256: string,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<readonly Diagnostic[]> {
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete' || loaded.result.source.sha256 !== sourceSha256) return [{ severity: 'error' as const,
        code: 'GENERATED_SOURCE_CHANGED', message: 'the configuration changed while check was reading the Compose topology', target: configPath }]
    const config = loaded.result.config
    if (declaredRuntime(config.environment) !== 'compose') return []
    const env = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
        DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY, DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH }
    const [docker, node] = await Promise.all([resolveDockerExecutable(process.env), nodeAuthority()])
    const observed = docker.state !== 'available' ? { kind: 'unavailable' as const, reason: docker.reason }
        : !node ? { kind: 'unavailable' as const, reason: 'the current Node executable could not be authenticated' }
            : await observeComposeTopology({ root: dirname(loaded.result.source.path), references: config.environment.compose_files,
                projectName: config.cockpit.name, docker: docker.value, node, env }, adapters.execute)
    if (observed.kind !== 'complete') return [{ severity: 'error' as const, code: 'COMPOSE_TOPOLOGY_UNAVAILABLE',
        message: `check could not read the declared Compose topology, so its ports, healthchecks and images are unverified: ${observed.reason}`,
        target: config.environment.compose_files.join(', '),
        fix: 'install Docker with the Compose plugin on PATH and make `docker compose config` succeed for environment.compose_files' }]
    const root = dirname(loaded.result.source.path)
    const siblingsRoot = resolve(root, config.cockpit.siblings_root)
    return assessComposeTopology(observed.services, {
        projectDirectory: composeProjectDirectory(root, config.environment.compose_files),
        portVariables: Object.keys(config.ports.bases),
        siblings: config.sibling.map(sibling => ({
            slug: sibling.slug, var: sibling.var, mount: sibling.mount, path: resolve(siblingsRoot, sibling.dir) })),
        hostPaths: config.environment.generated_host_paths.map(declared => ({ declared, path: resolve(root, declared) })),
    })
}

export async function checkGeneratedEnvironment(
    input: GeneratedEnvironmentCommandInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<GeneratedEnvironmentCommandOutcome> {
    const adapters = mergedAdapters(adapterOverrides)
    const currentness = await prepareGeneratedEnvironmentCurrentness(input, adapters)
    const findings = currentness.outcome.kind === 'complete'
        ? await composeTopologyDiagnostics(input.configPath, currentness.outcome.result.sourceSha256, adapters) : []
    const diagnostics = [...currentness.outcome.diagnostics, ...findings]
    const outcome = findings.some(row => row.severity === 'error')
        ? { kind: 'refusal' as const, artifact: null, destination: null, result: null, status: 2 as const, diagnostics }
        : { ...currentness.outcome, diagnostics }
    return { ...outcome, fixContext: currentness.fixContext, report: {
        storedProducer: currentness.storedProducer, currentProducer: currentness.currentProducer,
        repair: proposeGeneratedEnvironmentRepair(currentness),
    } }
}
