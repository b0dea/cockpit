import { prepareTeamMetadata, applyTeamMetadata, type TeamMetadataChange } from '../team-metadata.js'
import { installedPackageMetadata } from '../package-metadata.js'
import type { FixContext } from '../fix-catalogue.js'
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
import { bindBrowserRuntimePortLease, browserClientLimit, resolveBrowserRuntime, type BrowserRuntimeProjection } from '../browser/runtime.js'
import { resolveObservationPostures } from './posture-observation.js'
import type { Diagnostic } from '../diagnostics.js'
import { authenticatedExecutionOutcome, executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { deriveRegistry, type DerivedRegistry } from '../registry-derivation.js'
import { SURFACE_FEATURES, SURFACE_TARGETS, type RenderedSurfaceFile, type SurfaceFeature, type SurfaceSourceFile, type SurfaceTarget } from '../surfaces/contract.js'
import { GUARD_SURFACE_TARGETS, harnessFact, isGuardSurfaceTarget, SURFACE_PUBLICATION_ANCHORS } from '../surfaces/harness-registry.js'
import { mergeAdoptedSurface } from '../surfaces/adoption.js'
import { generateSurfaceEstate, type SurfaceGenerationOutcome, type SurfaceGenerationWarning } from '../surfaces/generator-adapter.js'
import { mergeSurfaceDeclarations, type ActiveSurfaceOverride, type SurfaceUpgradeFinding } from '../surfaces/merge.js'
import {
    CORE_EVALUATOR_ASSET as EVALUATOR_ASSET,
    CORE_SKILL_ASSETS as SKILL_ASSETS,
    coreSurfaceDeclarations,
    shippedSkillNames,
} from '../surfaces/core-declarations.js'
import { collectMcpDeclarations, hasTargetMcpServers, parseMcpDeclarationFile, type McpCollectionOutcome, type McpDeclaration } from '../surfaces/mcp.js'
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
    type SurfacePriorOwnedEntry,
} from '../surfaces/ownership.js'
import { observeSiblingGuides, planSiblingProjection, type DirectoryGrant, type GuideObservation, type GuideObservationRequest, type ProjectionPlannerInput, type StandingCost } from '../surfaces/projection.js'
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
import { GUARD_LOCAL_PATHS, writeGuardLocalIdentity, type GuardHandlerIdentity } from '../guards/local-identity.js'
import { fileFingerprint, verifiedDigest } from '../environment-exec/verified-digest.js'
import { planSurfaceChanges, type SurfaceChange, type SurfaceObservedEntry, type SurfaceChangePlanResult } from '../surfaces/sync.js'
import { SHIPPED_SETUP_SKILL, extendInspectedSkillStandingCosts, inspectRenderedSkillSet, inspectSkillSet, projectInspectedSkillOutputs, type InspectedBootstrapOutputs, type SkillStandingCost } from '../surfaces/skill-contract.js'
import {
    nodeAuthority, readAnchoredFile, readAnchoredEntry, readAnchoredBatches, readPersonaSource, expectedState, portablePublicationPaths, admitPublicationPlan, authorizePublicationPlan, runPublicationPlan,
    type AnchoredEntry, type AnchoredBatchReadResult, type PublicationMutation, type DirectoryIdentity, type PersonaSourceIdentity,
    type GeneratedStaleRemovalApprovalRequest, type GeneratedStaleRemovalApproval, type PublicationPlan,
} from '../generated-environment/transaction.js'
import { ENVIRONMENT_CODES, snapshotEnvironmentObservation, snapshotExecutionStep, snapshotGeneratedJson, type EnvironmentObservation, type ExecutionStep, type CockpitId } from './contract.js'
import type { ResolvedExecutable } from './executable.js'
import { resolveDockerExecutable, resolveExecutablePath, resolveGitExecutable } from './executable.js'
import { checkoutId, cockpitId, publicationCockpitId, stackId } from './identity.js'
import { assessComposeTopology, observeComposeTopology } from './compose-topology.js'
import { declaredRuntime } from './declaration.js'
import { COMPOSE_OWNERSHIP_FILE, renderComposeOwnership } from './compose-ownership.js'
import {
    admitGeneratedObservation,
    createGeneratedObservationExecution,
    inspectGeneratedEnvironment,
    observeGeneratedEnvironmentHealth,
    projectGeneratedComposeArtifactAuthority,
    projectGeneratedRuntimeAuthority,
    resolveGeneratedDataOperation,
    renderGeneratedEnvironment,
    undecidedGeneratedDecisions,
    type GeneratedDataOperation,
    type GeneratedObservationRuntime,
    type GeneratedRuntimeAuthority,
    type GeneratedHostInputRoot,
    type GeneratedEnvironmentResult,
} from './generated-stack.js'
import type { GeneratedComposeArtifactAuthority } from './generated-stack.js'
import { projectPersonaOutputs, type DataStepContext } from './data-plane.js'
import { decodeLifecycleRecord, resolveLifecycleStage } from './lifecycle-stage.js'
import { authenticateStatePublication, observeConfiguration, readState, selectStateRoot,
    type BootstrapStateAddress, type BootstrapStateRecord, type StateNamespace, type StateResult } from './state.js'
import {
    deriveEntrypoints,
    inspectPortLeaseProjection,
    observeRetainedPortFamily,
    projectRetainedPortFamilyResult,
    type PortLeaseProjection,
} from './ports.js'
import { TESTING_GUIDE_REGISTRY, createGateRegistry, renderTierGuide, type GateRegistry } from '../testing/gates.js'
import { NATIVE_HOOK_COST_SCRIPT, projectNativeHooks, type NativeHookEntry, type NativeHookPolicy } from '../testing/hooks.js'
import type { RuntimeTopologyEvidence } from './runtime.js'
import { observeGeneratedCheckoutIdentity, revalidateGeneratedCheckoutIdentity, type GeneratedCheckoutIdentity } from './setup-observation.js'

export const mechanism = {
    id: 'generated-environment-application',
    module: 'packages/cockpit/src/environment/generated-application.ts',
    exports: ['prepareGeneratedEnvironmentCurrentness', 'prepareWorkApplicationAuthorities', 'applyGeneratedEnvironmentRepair', 'syncGeneratedEnvironment', 'syncTeamGeneratedEnvironment', 'checkGeneratedEnvironment', 'generatedApplicationProjection', 'projectWorkApplicationAuthorities', 'consumeWorkApplicationAuthorities', 'prepareSelectedBootstrapSurface', 'resumeSelectedBootstrapSurface', 'applySelectedBootstrapSurface', 'inspectBrowserDebuggerPreparation', 'projectGeneratedApplicationNodeExecutable', 'projectGeneratedApplicationMountSources', 'projectGeneratedApplicationRuntimeAuthority', 'resolveGeneratedApplicationOperation', 'observeGeneratedApplicationSurfaces', 'observeGeneratedApplicationHealth', 'observeGeneratedApplication', 'isGeneratedApplicationSurfaceObservation', 'surfaceObservationDeclarations'],
} as const

export const surfaceObservationDeclarations = Object.freeze([
    { id: 'harness-surfaces', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
    { id: 'directory-grants', owner: mechanism.id, postures: ['directory-grants'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
    { id: 'guide-budget', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
    { id: 'skill-budget', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE, isIssued: isGeneratedApplicationSurfaceObservation, issuedAt: generatedApplicationSurfaceObservationIssuedAt },
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
    readonly personaSource: Readonly<{ path: string; sha256: string }>
    readonly personaSourceIdentity: PersonaSourceIdentity
    readonly generation: string
    // Present only when environment.generated is declared; a surfaces-only or compose-first cockpit renders no stack.
    readonly rendered?: Extract<GeneratedEnvironmentResult, { kind: 'complete' }>
    readonly generatedComposeAuthority?: GeneratedComposeArtifactAuthority
    readonly generated: readonly OwnedBytes[]
    readonly persona: readonly OwnedBytes[]
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
    readonly surfaceAssets: readonly SurfaceAssetIdentity[]
    readonly warnings: readonly SurfaceGenerationWarning[]
    readonly registry: DerivedRegistry
    readonly siblingRoots: AuthenticatedSiblingRoots
    readonly hostInputRoots: Readonly<Record<string, GeneratedHostInputRoot>>
    readonly hostInputs: readonly GeneratedHostInput[]
    readonly workEnvironment: ConsumedWorkEnvironmentConfig
    readonly workApplication?: WorkApplicationAuthorityRecord
    readonly browserRunner?: BrowserRunnerAuthority
    readonly portLease?: PortLeaseProjection
    readonly inspection?: Readonly<{ kind: 'passed' }>
    readonly node: ResolvedExecutable
    readonly guardHandler?: GuardHandlerIdentity
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
        return false
    }
}

async function authenticateSiblingRoots(
    root: string,
    config: DerivedRegistry['config'],
): Promise<Readonly<{ kind: 'complete'; roots: AuthenticatedSiblingRoots }>
    | Readonly<{ kind: 'refusal'; reason: string }>> {
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
            const canonical = await realpath(declared)
            const status = await lstat(canonical)
            if (!containedPath(canonicalRoot, canonical)) {
                return { kind: 'refusal', reason: `sibling ${sibling.slug} resolves outside the declared sibling root` }
            }
            if (!status.isDirectory() || status.isSymbolicLink()) {
                return { kind: 'refusal', reason: `sibling ${sibling.slug} is not an ordinary directory` }
            }
            siblings.set(sibling.slug, Object.freeze({ root: canonical, identity: Object.freeze({ dev: status.dev, ino: status.ino }) }))
        }
        return { kind: 'complete', roots: Object.freeze({
            declaredRoot, canonicalRoot, rootIdentity: Object.freeze({ dev: rootStatus.dev, ino: rootStatus.ino }), siblings,
        }) }
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown filesystem error'
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
    readonly generation: string
    /** Absent when no generated environment is declared; there is then no cockpit-rendered Compose file to authenticate. */
    readonly generatedComposeAuthority?: GeneratedComposeArtifactAuthority
    readonly profiles: readonly string[]
    readonly mounts: readonly string[]
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
        readonly runner?: BrowserRunnerAuthority
    }>
    readonly testing: Readonly<{ readonly registry: GateRegistry }>
}

export interface BrowserRunnerAuthority {
    readonly serviceId: 'cockpit-browser-runner'
    readonly hostVariable: string
    readonly proxyPort: number
    readonly manifest: Readonly<{ path: string; sha256: string; identity: string; provenance: 'declared'; reason: string }>
    readonly lockfile: Readonly<{ path: string; sha256: string; identity: string }>
    readonly debugger?: BrowserDebuggerPreparation
}

export interface BrowserDebuggerPreparation {
    readonly kind: 'foreground-browser-debugger'
    readonly cwd: string
    readonly launcher: Readonly<{ path: string; sha256: string }>
    readonly argv: readonly string[]
    readonly deadlineSeconds: number
    readonly foreground: true
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
        decisions?: GeneratedDecisionReport
    }>
}>

// Undecided subjects are reported, never refused: the log shows them, and check counts them.
export type GeneratedDecisionReport = Readonly<{ path: string; undecided: number; subjects: readonly string[] }>

const defaultAdapters: GeneratedEnvironmentCommandAdapters = { observeSource: observeConfigSource, execute: executeProbe }
const OWNERSHIP_PATH = '.cockpit/generated-environment-ownership.json'
const SECRET_IGNORE_PATH = 'env/.secrets/.gitignore'
const SECRET_IGNORE_BYTES = '# cockpit-owned: secret resolver material stays outside Git\n*\n'
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
    'references/identity-provider-clerk.md',
] as const)
const WORK_ASSETS = Object.freeze([
    'skills/cockpit-browser.skill.md',
    'references/browser.md',
    'references/testing-tiers.md',
    'scripts/browser-runner.sh',
] as const)
type SurfaceAssetPath = typeof RESTRICTION_ASSETS[number] | typeof EVALUATOR_ASSET | typeof SKILL_ASSETS[number] | typeof REFERENCE_ASSETS[number] | typeof WORK_ASSETS[number]
interface GeneratedHostInput {
    readonly root: GeneratedHostInputRoot
    readonly source: string
    readonly type: 'file' | 'directory'
    readonly mount: boolean
}

interface GeneratedApplicationRecord {
    readonly root: string
    readonly stackId: ReturnType<typeof stackId>
    readonly currentPublication: true | false
    readonly siblingRoots: AuthenticatedSiblingRoots
    readonly hostInputRoots: Readonly<Record<string, GeneratedHostInputRoot>>
    readonly hostInputs: readonly GeneratedHostInput[]
    readonly rendered?: Extract<GeneratedEnvironmentResult, { kind: 'complete' }>
    readonly inspection?: Readonly<{ kind: 'passed' }>
    readonly node: ResolvedExecutable
    readonly workApplication?: WorkApplicationAuthorityRecord
    readonly surfaceSelftest: GeneratedSurfaceSelftestProjection
    readonly surfaceHealth: GeneratedSurfaceHealthEvidence
}

type WorkApplicationAuthorityRecord = ConsumedWorkApplicationAuthorities

const issuedApplicationProjections = new WeakMap<object, GeneratedApplicationRecord>()
const projectedWorkApplicationAuthorities = new WeakSet<object>()
const issuedWorkApplicationAuthorities = new WeakMap<object, WorkApplicationAuthorityRecord>()
const issuedBrowserDebuggerPreparations = new WeakMap<object, BrowserRuntimeProjection>()

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

export function inspectBrowserDebuggerPreparation(value: unknown, runtime: BrowserRuntimeProjection): BrowserDebuggerPreparation | undefined {
    return value !== null && typeof value === 'object' && issuedBrowserDebuggerPreparations.get(value) === runtime
        ? value as BrowserDebuggerPreparation : undefined
}

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
        return undefined
    }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(record).sort()
    const wanted = [...expected].sort()
    return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

function guideLines(bytes: string): number {
    return bytes.trimEnd().split('\n').length
}

function refuse(code: string, message: string, target?: string, fix?: string): RefusalOutcome {
    return Object.freeze({
        kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: Object.freeze([{ severity: 'error' as const, code, message, target, fix }]),
    })
}

function complete(
    action: CommandResult['action'],
    prepared: PreparedEnvironment,
    dryRun = false,
    changes: readonly GeneratedEnvironmentChange[] = Object.freeze([]),
    staleRemoval?: GeneratedStaleRemovalApprovalRequest,
): CompleteOutcome | RefusalOutcome {
    if (!prepared.surfaceSelftest || !prepared.surfaceHealth) return refuse('SURFACE_INPUT_INVALID', 'authenticated surface health inputs are missing', 'surfaces')
    const generatedPaths = generatedPathFacts(prepared, dryRun ? 'declared-before-sync' : 'required-after-sync')
    if (generatedPaths.kind !== 'complete') return refuse(generatedPaths.diagnostic.code, generatedPaths.diagnostic.message, generatedPaths.diagnostic.target)
    const application = Object.freeze({
        generatedPaths: generatedPaths.facts,
        sourceSha256: prepared.sourceSha256,
        generation: prepared.generation,
        ...(prepared.generatedComposeAuthority ? { generatedComposeAuthority: prepared.generatedComposeAuthority } : {}),
        surfaceSelftest: prepared.surfaceSelftest,
        activeSurfaceOverrides: prepared.activeSurfaceOverrides,
        changedOverrideOriginals: prepared.changedOverrideOriginals,
        profiles: Object.freeze([...prepared.rendered?.replay.profiles ?? []]),
        mounts: Object.freeze([...prepared.rendered?.replay.mounts ?? []]),
        inspection: Object.freeze({
            kind: 'passed' as const,
            files: Object.freeze(prepared.owned.map(({ path, sha256: digest }) => Object.freeze({ path, sha256: digest, ownership: 'whole-file' as const }))),
        }),
    })
    issuedApplicationProjections.set(application, Object.freeze({
        root: prepared.root, stackId: prepared.stackId, currentPublication: !dryRun,
        siblingRoots: prepared.siblingRoots, hostInputRoots: prepared.hostInputRoots, hostInputs: prepared.hostInputs,
        ...(prepared.rendered && prepared.inspection ? { rendered: prepared.rendered, inspection: prepared.inspection } : {}),
        node: prepared.node, surfaceSelftest: prepared.surfaceSelftest, surfaceHealth: prepared.surfaceHealth,
        ...(!dryRun && prepared.workApplication ? { workApplication: prepared.workApplication } : {}),
    }))
    return Object.freeze({
        kind: 'complete', artifact: null, destination: null,
        diagnostics: Object.freeze(prepared.warnings.map(({ severity, code, target, path, message }) => Object.freeze({
            severity, code, target: `${target}:${path}`, message,
        }))),
        status: 0,
        result: Object.freeze({
            action,
            dryRun,
            changes,
            generation: prepared.generation,
            sourceSha256: prepared.sourceSha256,
            paths: Object.freeze([...prepared.owned.map(({ path }) => path), ...prepared.surfaces.map(({ path }) => path)].sort(compareCodeUnits)),
            application,
            ...(staleRemoval ? { staleRemoval } : {}),
        }),
    })
}

function generatedPathFacts(prepared: PreparedEnvironment, applicability: 'declared-before-sync' | 'required-after-sync') {
    const manifest = encodeOwnershipManifest(prepared).manifest
    const declarations: GeneratedPathDeclaration[] = [
        ...prepared.generated.map(file => ({ producer: 'generated-environment' as const, applicability,
            entry: manifest.entries.find(entry => entry.path === file.path)! })),
        ...prepared.owned.filter(file => file.path === SECRET_IGNORE_PATH).map(file => ({ producer: 'generated-environment' as const, applicability,
            entry: manifest.entries.find(entry => entry.path === file.path)! })),
        ...prepared.persona.map(file => ({ producer: 'environment-data-plane' as const, applicability,
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
    const projection: WorkApplicationAuthoritiesProjection = Object.freeze({ kind: 'work-application-authorities' })
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
    if (loaded.kind !== 'complete') return Object.freeze({
        kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: Object.freeze([...loaded.diagnostics]),
    })
    const configProjection = projectWorkEnvironmentConfig(loaded.result)
    const workEnvironment = configProjection && consumeWorkEnvironmentConfigProjection(configProjection)
    const node = await nodeAuthority()
    if (!workEnvironment || !node) return refuse('GENERATED_RENDER_UNAUTHENTICATED', 'work configuration or Node authority is unavailable', request.configPath)
    const read = await readAnchoredFile(SURFACE_ROOT, EVALUATOR_ASSET, MAX_SURFACE_FILE_BYTES, node, defaultAdapters)
    const evaluator = readSurfaceAsset(EVALUATOR_ASSET, read)
    if (!evaluator) return refuse('SURFACE_INPUT_INVALID', 'the shipped evaluator could not be authenticated', EVALUATOR_ASSET)
    const projection: WorkApplicationAuthoritiesProjection = Object.freeze({ kind: 'work-application-authorities' })
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
    if (!record || !exactKeys(record, ['root', 'target']) || typeof record.root !== 'string'
        || !isAbsolute(record.root) || resolve(record.root) !== record.root
        || !SURFACE_TARGETS.includes(record.target as SurfaceTarget)) return undefined
    return Object.freeze({ root: record.root, target: record.target as SurfaceTarget })
}

function selectedBootstrapSources(assets: ReadonlyMap<SurfaceAssetPath, Readonly<{ bytes: string }>>): readonly SurfaceSourceFile[] | undefined {
    const terminal = assets.get('skills/procedures/onboarding.md')?.bytes
    const names = shippedSkillNames(assets)
    const entries = names?.map(name => [name, assets.get(`skills/${name}.skill.md` as SurfaceAssetPath)?.bytes] as const)
    if (terminal === undefined || !entries || entries.some(([, bytes]) => bytes === undefined)) return undefined
    return Object.freeze(entries.flatMap(([name, bytes]) => [
        Object.freeze({ path: `skills/${name}/SKILL.md`, bytes: bytes! }),
        Object.freeze({ path: `skills/${name}/procedures/onboarding.md`, bytes: terminal }),
    ]))
}

async function selectedBootstrapAssets(
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<readonly Readonly<{ path: SurfaceAssetPath; bytes: string; sha256: string; identity: PersonaSourceIdentity }>[] | undefined> {
    const reads = await readAnchoredBatches(SURFACE_ROOT, SKILL_ASSETS.map(path => Object.freeze({
        path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
    })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== SKILL_ASSETS.length) return undefined
    const assets = SKILL_ASSETS.map((path, index) => readSurfaceAsset(path, reads.results[index]!))
    return assets.every((asset): asset is NonNullable<typeof asset> => asset !== undefined) ? Object.freeze(assets) : undefined
}

async function selectedBootstrapRecordCurrent(record: SelectedBootstrapRecord): Promise<boolean> {
    try {
        const root = await lstat(record.root)
        if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== record.rootIdentity.dev || root.ino !== record.rootIdentity.ino) return false
        const reads = await readAnchoredBatches(SURFACE_ROOT, record.assets.map(asset => Object.freeze({
            path: asset.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
        })), record.node, record.adapters)
        const state = record.bootstrapState && await readState(record.bootstrapState.address)
        return (!record.bootstrapState || state?.kind === 'complete'
                && JSON.stringify(state.value) === JSON.stringify(record.bootstrapState.record))
            && !!reads && reads.kind === 'complete' && reads.results.length === record.assets.length
            && reads.results.every((read, index) => read.kind === 'complete' && read.sha256 === record.assets[index]!.sha256
                && sourceIdentity(read.identity) === sourceIdentity(record.assets[index]!.identity))
    } catch {
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
        if (root !== captured.root || !status.isDirectory() || status.isSymbolicLink()) throw new Error('root')
        rootIdentity = Object.freeze({ dev: status.dev, ino: status.ino })
    } catch {
        return refuse('GENERATED_INPUT_INVALID', 'selected bootstrap root is not a canonical directory', captured.root)
    }
    const node = await nodeAuthority()
    const assets = node && await selectedBootstrapAssets(node, adapters)
    if (!node || !assets) return refuse('SURFACE_INPUT_INVALID', 'packaged bootstrap assets could not be authenticated', 'bootstrap')
    const byPath = new Map(assets.map(asset => [asset.path, asset]))
    const sources = selectedBootstrapSources(byPath)
    const collection = byPath.get('skills/collection.json')
    const terminal = byPath.get('skills/procedures/onboarding.md')
    if (!sources || !collection || !terminal) return refuse('SURFACE_INPUT_INVALID', 'packaged bootstrap assets are incomplete', 'bootstrap')
    const inspection = await inspectSkillSet({ sources,
        collection: { path: collection.path, bytes: collection.bytes, sha256: collection.sha256 },
        terminal: { path: terminal.path, bytes: terminal.bytes, sha256: terminal.sha256 } })
    if (inspection.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'packaged bootstrap skill set was refused', 'bootstrap')
    const inspected = projectInspectedSkillOutputs(inspection, captured.target, SHIPPED_SETUP_SKILL)
    if (inspected.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'selected bootstrap output set was refused', captured.target)
    const reads = await readAnchoredBatches(root, inspected.files.map(file => Object.freeze({
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
        if (current.kind === 'missing') mutations.push(Object.freeze({ path: file.path, phase: 'desired', operation: 'write-file',
            bytes: file.bytes, sha256: file.sha256, expected: Object.freeze({ kind: 'missing' as const }) }))
    }
    const admitted = await admitPublicationPlan({ mode: 'bootstrap', root, rootIdentity, node, inspected,
        mutations: Object.freeze(mutations) }, adapters)
    if (admitted.kind !== 'complete') return admitted
    const sourceRows = Object.freeze(sources.map(source => Object.freeze({ path: source.path, sha256: sha256(source.bytes) })))
    const files = Object.freeze(inspected.files.map(file => Object.freeze({ path: file.path, sha256: file.sha256 })))
    const previewSha256 = sha256(JSON.stringify({ target: captured.target, sources: sourceRows, files }))
    const result: SelectedBootstrapSurfaceResult = Object.freeze({ root, target: captured.target, sources: sourceRows, files,
        previewSha256, changes: admitted.plan.changes })
    const authority: SelectedBootstrapPublicationAuthority = Object.freeze({ kind: 'selected-bootstrap-publication-authority' })
    issuedSelectedBootstrapAuthorities.set(authority, Object.freeze({ root, rootIdentity, target: captured.target, node,
        assets: Object.freeze(assets.map(({ path, sha256: digest, identity }) => Object.freeze({ path, sha256: digest, identity }))),
        inspected, result, plan: admitted.plan, adapters }))
    return Object.freeze({ kind: 'complete', artifact: null, destination: null, diagnostics: Object.freeze([]), result, authority, status: 0 })
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
    return Object.freeze({ kind: 'complete', artifact: null, destination: null, diagnostics: Object.freeze([]),
        result: record.result, authority, status: 0 })
}

export async function resumeSelectedBootstrapSurface(
    input: SelectedBootstrapResumeInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<SelectedBootstrapResumeOutcome> {
    const captured = selectedBootstrapInput({ root: input.root, target: input.target })
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
        if (!status.isDirectory() || status.isSymbolicLink() || await realpath(captured.root) !== captured.root) throw new Error('root')
        rootIdentity = Object.freeze({ dev: status.dev, ino: status.ino })
    } catch {
        return refuse('GENERATED_INPUT_INVALID', 'selected bootstrap root is not a canonical directory', captured.root)
    }
    const node = await nodeAuthority()
    if (!node) return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume could not authenticate the node executable', 'bootstrap')
    const ownership = await readAnchoredEntry(captured.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, node, adapters)
    if (ownership.kind !== 'missing' && ownership.kind !== 'file') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap resume ownership could not be read safely', OWNERSHIP_PATH,
    )
    const assets = await selectedBootstrapAssets(node, adapters)
    if (!assets) return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume packaged assets could not be authenticated', 'bootstrap')
    const byPath = new Map(assets.map(asset => [asset.path, asset]))
    const sources = selectedBootstrapSources(byPath)
    const collection = byPath.get('skills/collection.json')
    const terminal = byPath.get('skills/procedures/onboarding.md')
    if (!sources || !collection || !terminal) return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume packaged assets are incomplete', 'bootstrap')
    const inspection = await inspectSkillSet({ sources,
        collection: { path: collection.path, bytes: collection.bytes, sha256: collection.sha256 },
        terminal: { path: terminal.path, bytes: terminal.bytes, sha256: terminal.sha256 } })
    if (inspection.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume skill set was refused', 'bootstrap')
    const inspected = projectInspectedSkillOutputs(inspection, captured.target, SHIPPED_SETUP_SKILL)
    if (inspected.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'bootstrap resume output projection was refused', captured.target)
    const sourceRows = Object.freeze(sources.map(source => Object.freeze({ path: source.path, sha256: sha256(source.bytes) })))
    const files = Object.freeze(inspected.files.map(file => Object.freeze({ path: file.path, sha256: file.sha256 })))
    const previewSha256 = sha256(JSON.stringify({ target: captured.target, sources: sourceRows, files }))
    const state = durable.value.value
    const sourcesCurrent = JSON.stringify(state.sources) === JSON.stringify(sourceRows)
        && JSON.stringify(state.published) === JSON.stringify(files) && state.previewSha256 === previewSha256
    if (ownership.kind === 'missing') {
        if (sourcesCurrent) return Object.freeze({ kind: 'pending', status: 0, diagnostics: Object.freeze([]),
            result: null, canonicalOwnership: false })
        const priorPreviewSha256 = sha256(JSON.stringify({ target: captured.target, sources: state.sources, files: state.published }))
        if (input.expectedRevision !== durable.value.revision || input.expectedCommandSha256 !== state.commandSha256
            || priorPreviewSha256 !== state.previewSha256 || state.stage !== 'surface-published'
            || JSON.stringify(state.published.map(row => row.path)) !== JSON.stringify(files.map(row => row.path))) return refuse(
            'GENERATED_SOURCE_CHANGED', 'bootstrap resume package sources differ from the accepted durable preview', 'bootstrap',
        )
        const reads = await readAnchoredBatches(captured.root, inspected.files.map(file => Object.freeze({
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
            mutations.push(Object.freeze({ path: file.path, phase: 'desired', operation: 'write-file',
                bytes: file.bytes, sha256: file.sha256, expected }))
        }
        const admitted = await admitPublicationPlan({ mode: 'bootstrap', root: captured.root, rootIdentity, node, inspected,
            mutations: Object.freeze(mutations), refresh: Object.freeze({ address: input.address,
                revision: durable.value.revision, commandSha256: state.commandSha256 }) }, adapters)
        if (admitted.kind !== 'complete') return admitted
        const result: SelectedBootstrapSurfaceResult = Object.freeze({ root: captured.root, target: captured.target,
            sources: sourceRows, files, previewSha256, changes: admitted.plan.changes })
        const authority: SelectedBootstrapPublicationAuthority = Object.freeze({ kind: 'selected-bootstrap-publication-authority' })
        issuedSelectedBootstrapAuthorities.set(authority, Object.freeze({ root: captured.root, rootIdentity,
            target: captured.target, node,
            assets: Object.freeze(assets.map(({ path, sha256: digest, identity }) => Object.freeze({ path, sha256: digest, identity }))),
            inspected, result, plan: admitted.plan, adapters,
            bootstrapState: Object.freeze({ address: input.address, record: durable.value }),
        }))
        return Object.freeze({ kind: 'refresh', status: 0, diagnostics: Object.freeze([]), result, authority,
            canonicalOwnership: false })
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
    return Object.freeze({ kind: 'complete', status: 0, diagnostics: Object.freeze([]), canonicalOwnership: true,
        result: Object.freeze({ root: captured.root, target: captured.target, sources: sourceRows, files, previewSha256,
            changes: Object.freeze([]) }) })
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
    if (record.value.stage === 'surface-previewed' || record.value.checkoutRoot !== root || record.target !== state.address.target
        || state.address.checkoutRoot !== root || record.value.target !== record.target) return undefined
    const assets = await selectedBootstrapAssets(node, adapters)
    if (!assets) return undefined
    const byPath = new Map(assets.map(asset => [asset.path, asset]))
    const sources = selectedBootstrapSources(byPath)
    const collection = byPath.get('skills/collection.json')
    const terminal = byPath.get('skills/procedures/onboarding.md')
    if (!sources || !collection || !terminal) return undefined
    const sourceRows = sources.map(source => ({ path: source.path, sha256: sha256(source.bytes) }))
    if (JSON.stringify(sourceRows) !== JSON.stringify(record.value.sources)) return undefined
    const inspection = await inspectSkillSet({ sources,
        collection: { path: collection.path, bytes: collection.bytes, sha256: collection.sha256 },
        terminal: { path: terminal.path, bytes: terminal.bytes, sha256: terminal.sha256 } })
    if (inspection.kind !== 'complete') return undefined
    const inspected = projectInspectedSkillOutputs(inspection, record.target, SHIPPED_SETUP_SKILL)
    if (inspected.kind !== 'complete') return undefined
    const published = inspected.files.map(file => ({ path: file.path, sha256: file.sha256 }))
    if (JSON.stringify(published) !== JSON.stringify(record.value.published)) return undefined
    const reads = await readAnchoredBatches(root, inspected.files.map(file => Object.freeze({
        path: file.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-entry' as const,
    })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== inspected.files.length
        || reads.results.some((read, index) => read.kind !== 'file' || read.sha256 !== inspected.files[index]!.sha256)) return undefined
    consumedBootstrapStatePublications.add(publication)
    return Object.freeze(inspected.files.map(file => Object.freeze({
        kind: 'file' as const, path: file.path, harnesses: [record.target] as [SurfaceTarget], scope: 'always' as const,
        capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const,
        ownership: 'whole-file' as const, sha256: file.sha256,
    })))
}

export function projectGeneratedApplicationNodeExecutable(application: GeneratedApplicationProjection): ResolvedExecutable | undefined {
    if (application === null || typeof application !== 'object') return undefined
    return issuedApplicationProjections.get(application)?.node
}

interface GeneratedHostInputRefusal {
    readonly kind: 'refusal'
    readonly path: string
    readonly expectedType: 'file' | 'directory'
}

export async function projectGeneratedApplicationMountSources(application: GeneratedApplicationProjection): Promise<readonly string[] | GeneratedHostInputRefusal | undefined> {
    const record = application !== null && typeof application === 'object' ? issuedApplicationProjections.get(application) : undefined
    if (!record?.rendered || !await siblingRootsCurrent(record.siblingRoots)) return undefined
    const sources: string[] = []
    const roots = new Set([...Object.values(record.hostInputRoots), ...record.hostInputs.map(input => input.root)])
    try {
        for (const root of roots) {
            const status = await lstat(root.path)
            if (await realpath(root.path) !== root.path || !status.isDirectory() || status.isSymbolicLink()
                || status.dev !== root.dev || status.ino !== root.ino) return undefined
        }
        // The later generated observations diagnose running services. Admit the exact declared
        // host inputs here so Compose cannot follow an existing link before those probes run.
        for (const input of record.hostInputs) {
            const root = input.root
            const target = resolve(root.path, input.source)
            const refusal: GeneratedHostInputRefusal = Object.freeze({ kind: 'refusal', path: target, expectedType: input.type })
            if (!containedPath(root.path, target)) return refusal
            const parts = relative(root.path, target).split(sep).filter(Boolean)
            let current = root.path
            if (parts.length === 0 && input.type !== 'directory') return refusal
            try {
                for (const [index, part] of parts.entries()) {
                    current = resolve(current, part)
                    const status = await lstat(current)
                    const directory = index < parts.length - 1 || input.type === 'directory'
                    if (status.isSymbolicLink() || (directory ? !status.isDirectory() : !status.isFile())) return refusal
                }
                if (await realpath(target) !== target) return refusal
            } catch { return refusal }
            if (input.mount) sources.push(target)
        }
        for (const root of roots) {
            const status = await lstat(root.path)
            if (await realpath(root.path) !== root.path || !status.isDirectory() || status.isSymbolicLink()
                || status.dev !== root.dev || status.ino !== root.ino) return undefined
        }
    } catch { return undefined }
    return Object.freeze([...new Set(sources)].sort())
}

function generatedApplicationRuntimeAuthority(
    application: GeneratedApplicationProjection,
    input: unknown,
): GeneratedRuntimeAuthority | undefined {
    const record = application !== null && typeof application === 'object'
        ? issuedApplicationProjections.get(application)
        : undefined
    const captured = ownRecord(input)
    const runtime = captured ? ownRecord(captured.runtime) : undefined
    const hostExecutables = runtime?.hostExecutables === undefined ? {} : ownRecord(runtime.hostExecutables)
    if (!record?.rendered || !captured || !exactKeys(captured, ['runtime', 'topology']) || !runtime || !hostExecutables
        || runtime.root !== record.root || Object.hasOwn(hostExecutables, 'node')) return undefined
    return projectGeneratedRuntimeAuthority({
        rendered: record.rendered,
        hostInputRoots: record.hostInputRoots,
        topology: captured.topology as RuntimeTopologyEvidence,
        runtime: Object.freeze({
            ...runtime,
            hostExecutables: Object.freeze({ ...hostExecutables, node: record.node }),
        }) as unknown as GeneratedObservationRuntime,
    })
}

export function projectGeneratedApplicationRuntimeAuthority(
    application: GeneratedApplicationProjection,
    input: Readonly<{ topology: RuntimeTopologyEvidence; runtime: GeneratedObservationRuntime }>,
): GeneratedRuntimeAuthority | undefined {
    return generatedApplicationRuntimeAuthority(application, input)
}

export function resolveGeneratedApplicationOperation(
    application: GeneratedApplicationProjection,
    input: Readonly<{ topology: RuntimeTopologyEvidence; runtime: GeneratedObservationRuntime }>,
    operation: GeneratedDataOperation,
    context: DataStepContext,
): ExecutionStep | undefined {
    const authority = generatedApplicationRuntimeAuthority(application, input)
    return authority ? resolveGeneratedDataOperation({
        authority,
        operation,
        context,
    }) : undefined
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
            code: ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE, owner: mechanism.id, stackId: record.stackId,
            source: `surface-manifest:${record.surfaceSelftest.manifestSha256}`,
            observed: { state: 'available', value: { manifestSha256: record.surfaceSelftest.manifestSha256,
                harnesses: record.surfaceSelftest.configuredHarnesses, entries: record.surfaceSelftest.entries.length }, observedAt },
            expectation: { kind: 'present' }, applicability: required('environment'), freshness: { state: 'current' },
            remedy: 'run cockpit sync --config <file>, then rerun cockpit preflight',
        }),
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE, owner: mechanism.id, stackId: record.stackId,
            source: `directory-grants:${grantsSha256}`,
            observed: { state: 'available', value: { grants: record.surfaceHealth.grants.length,
                generatedFragments: record.surfaceHealth.nativeGrants.fragments.length, modelSha256: grantsSha256 }, observedAt },
            expectation: { kind: 'present' }, applicability: record.surfaceHealth.grants.length > 0
                ? required('directory-grants')
                : { state: 'not-applicable', posture: 'directory-grants', reason: 'the active sibling projection declares no directory grants' },
            freshness: { state: 'current' },
            remedy: 'run cockpit sync --config <file>, then rerun cockpit preflight',
        }),
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.GUIDE_CAP_EXCEEDED, owner: mechanism.id, stackId: record.stackId,
            source: `surface-guide-costs:${record.surfaceSelftest.manifestSha256}`,
            observed: { state: 'available', value: guideValue, observedAt }, expectation: { kind: 'maximum', value: guideCap },
            applicability: required('environment'), freshness: { state: 'current' },
            remedy: 'move conditional guidance behind its scoped or pull-loaded surface, then run cockpit sync --config <file>',
        }),
        snapshotEnvironmentObservation({
            code: ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE, owner: mechanism.id, stackId: record.stackId,
            source: `installed-skill-inventory:${record.surfaceHealth.skillInventorySha256}`,
            observed: { state: 'available', value: { coreCollectionSha256: record.surfaceHealth.skillCollectionSha256,
                inventorySha256: record.surfaceHealth.skillInventorySha256, inventory: record.surfaceHealth.skillInventory, skills: record.surfaceHealth.skills,
                costs: record.surfaceHealth.skillCosts.map(({ target, metric, value, cap }) => ({ target, metric, value, cap })) }, observedAt },
            expectation: { kind: 'present' }, applicability: required('environment'), freshness: { state: 'current' },
            remedy: 'move skill procedure text out of always-loaded entry points, then run cockpit sync --config <file>',
        }),
    ]
    if (!observations.every((observation): observation is EnvironmentObservation => observation !== undefined)) return undefined
    const issuedAt = Date.now()
    for (const observation of observations) issuedSurfaceObservations.set(observation, issuedAt)
    return Object.freeze(observations)
}

export function isGeneratedApplicationSurfaceObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedSurfaceObservations.has(value)
}

function generatedApplicationSurfaceObservationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedSurfaceObservations.get(value) : undefined
}

export async function observeGeneratedApplicationHealth(
    application: GeneratedApplicationProjection,
    input: Readonly<{ topology: RuntimeTopologyEvidence; runtime: GeneratedObservationRuntime }>,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<Readonly<{ environment: EnvironmentObservation; registryAuthentication: EnvironmentObservation }> | undefined> {
    const record = application !== null && typeof application === 'object'
        ? issuedApplicationProjections.get(application)
        : undefined
    const authority = generatedApplicationRuntimeAuthority(application, input)
    if (!record?.rendered || !record.inspection || !authority || typeof execute !== 'function') return undefined
    const admissions = []
    for (const observation of record.rendered.observations) {
        const execution = createGeneratedObservationExecution({ authority, observation })
        if (execution.kind !== 'planned') return undefined
        const admission = admitGeneratedObservation({ execution, outcome: await execute(execution.step) })
        if (!admission) return undefined
        admissions.push(admission)
    }
    return observeGeneratedEnvironmentHealth({ rendered: record.rendered, inspection: record.inspection, admissions })
}

export async function observeGeneratedApplication(
    application: GeneratedApplicationProjection,
    input: Readonly<{ topology: RuntimeTopologyEvidence; runtime: GeneratedObservationRuntime }>,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<EnvironmentObservation | undefined> {
    return (await observeGeneratedApplicationHealth(application, input, execute))?.environment
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
        return Object.freeze({ configPath })
    } catch {
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
        return Object.freeze({ configPath, dryRun, ...(bootstrapState === undefined ? {} : { bootstrapState }) })
    } catch {
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
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
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
        return { kind: 'invalid' }
    }
}

async function expectedOutputExists(prepared: PreparedEnvironment): Promise<boolean> {
    for (const file of prepared.owned) {
        if (await safePath(prepared.root, file.path, false)) return true
    }
    return false
}

function renderPersona(format: 'json' | 'typescript', source: Buffer): Uint8Array {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)) as unknown
    const json = `${JSON.stringify(value, null, 2)}\n`
    return Buffer.from(format === 'json' ? json : `export default ${json.trimEnd()} as const\n`)
}

async function projectBrowserRunner(
    workEnvironment: ConsumedWorkEnvironmentConfig,
    declaration: NonNullable<DerivedRegistry['config']['environment']['generated']>,
    portDefaults: Readonly<Record<string, number>>,
    root: string,
    node: ResolvedExecutable,
    adapters: GeneratedEnvironmentCommandAdapters,
) {
    const browser = workEnvironment.browser
    if (!browser || !Object.hasOwn(browser, 'endpoint')) return undefined
    const missing = [
        browser.project.manifest === undefined || browser.project.manifestSha256 === undefined ? 'browser.project.manifest+manifest_sha256' : undefined,
        browser.proxy.hostVariable === undefined ? 'browser.proxy.host_variable' : undefined,
        browser.images.runner.architectures === undefined ? 'browser.images.runner.architectures' : undefined,
        browser.runnerHealthMeasurement === undefined ? 'browser.runner_health_measurement' : undefined,
    ].filter((value): value is string => value !== undefined)
    if (missing.length > 0) return Object.freeze({ kind: 'refusal' as const,
        message: `configured remote browser runner requires explicit ${missing.join(', ')}` })
    const manifestPath = browser.project.manifest!
    const manifestSha256 = browser.project.manifestSha256!
    const hostVariable = browser.proxy.hostVariable!
    const architectures = browser.images.runner.architectures!
    const healthMeasurement = browser.runnerHealthMeasurement!
    if (portDefaults[hostVariable] !== browser.proxy.proxyPort) return Object.freeze({ kind: 'refusal' as const,
        message: 'configured remote browser proxy host variable does not match its declared base port' })
    const reads = await readAnchoredBatches(root, [
        Object.freeze({ path: browser.project.lockfile, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const }),
        Object.freeze({ path: manifestPath, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const }),
    ], node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== 2) return Object.freeze({ kind: 'refusal' as const,
        message: 'configured remote browser project files could not be read through the authenticated root' })
    const [lockfile, manifest] = reads.results
    if (!lockfile || !manifest || lockfile.kind !== 'complete' || manifest.kind !== 'complete'
        || lockfile.sha256 !== browser.project.sha256
        || manifestSha256 !== manifest.sha256) return Object.freeze({ kind: 'refusal' as const,
            message: 'configured remote browser project manifest or lockfile could not be authenticated' })
    let packageJson: unknown
    let lockJson: unknown
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        packageJson = JSON.parse(decoder.decode(manifest.bytes))
        lockJson = JSON.parse(decoder.decode(lockfile.bytes))
    } catch { return Object.freeze({ kind: 'refusal' as const, message: 'configured remote browser project files are not valid JSON' }) }
    const dependencies = ownRecord(packageJson)?.dependencies
    const devDependencies = ownRecord(packageJson)?.devDependencies
    const declared = ownRecord(dependencies)?.['@playwright/test'] ?? ownRecord(devDependencies)?.['@playwright/test']
    const packages = ownRecord(ownRecord(lockJson)?.packages)
    const installed = ownRecord(packages?.['node_modules/@playwright/test'])?.version
    if (typeof declared !== 'string' || installed !== browser.project.driverVersion) return Object.freeze({ kind: 'refusal' as const,
        message: 'configured remote browser project does not bind the exact driver version' })
    const provenance = Object.freeze({ ...healthMeasurement.provenance })
    const allowedHosts = browser.proxy.allowedHosts.map(host => host.replace(/:\d+$/, `:\${${hostVariable}:-${browser.proxy.proxyPort}}`))
    const endpoint = new URL(browser.endpoint!)
    const fixedArgs = ['--manifest', '/cockpit/project/package.json', '--lockfile', '/cockpit/project/package-lock.json',
        '--manifest-sha256', manifest.sha256, '--lock-sha256', lockfile.sha256, '--driver-version', browser.project.driverVersion,
        '--server-port', String(browser.proxy.serverPort), '--proxy-port', String(browser.proxy.proxyPort), '--max-clients', String(browserClientLimit(browser.maxClients, browser.authentication.policy)),
        '--artifacts', '/cockpit/artifacts', '--engine', browser.engine, '--ws-path', endpoint.pathname,
        ...[...new Set([...browser.proxy.allowedHosts, ...allowedHosts])].flatMap(host => ['--allowed-host', host]),
        ...browser.resolver.flatMap(({ hostname, address }) => ['--resolver-rule', `MAP ${hostname} ${address}`])]
    const command = ['/bin/sh', '/cockpit/browser-runner.sh', 'serve', ...fixedArgs]
    const probe = Object.freeze({ location: 'in-stack' as const, service: 'cockpit-browser-runner', cwd: '.' as const,
        argv: Object.freeze(['/bin/sh', '/cockpit/browser-runner.sh', 'check', browser.proxy.allowedHosts[0]!, String(browser.proxy.proxyPort)]), timeout_seconds: 10, provenance })
    const manifestProbe = Object.freeze({ location: 'host' as const, cwd: '.' as const,
        argv: Object.freeze(['docker', 'manifest', 'inspect', browser.images.runner.reference]), timeout_seconds: 30, provenance })
    const reason = 'The package manifest path and digest are explicitly declared.'
    return Object.freeze({ service: Object.freeze({
        id: 'cockpit-browser-runner', sibling: declaration.services[0]!.sibling, role: 'service' as const, profiles: Object.freeze([]),
        ...(browser.resources ? { resources: browser.resources } : {}),
        command: Object.freeze(command), image: Object.freeze({ reference: browser.images.runner.reference,
            reason: 'The configured browser runner image is digest-pinned and its architectures are explicitly declared.', architectures,
            manifest_probe: manifestProbe, provenance }),
        ports: Object.freeze([{ name: 'browser-proxy', host_variable: hostVariable, host_ip: browser.proxy.bind, internal: browser.proxy.proxyPort }]),
        ...(browser.resolver.length ? { host_aliases: browser.resolver } : {}),
        mounts: Object.freeze([
            { kind: 'environment-file' as const, source: '.cockpit/browser/runner.sh', target: '/cockpit/browser-runner.sh', source_type: 'file' as const },
            { kind: 'environment-file' as const, source: manifestPath, target: '/cockpit/project/package.json', source_type: 'file' as const },
            { kind: 'environment-file' as const, source: browser.project.lockfile, target: '/cockpit/project/package-lock.json', source_type: 'file' as const },
            { kind: 'bind' as const, source: browser.artifacts.runner, target: '/cockpit/artifacts', source_type: 'directory' as const },
        ]), dependencies: Object.freeze([]), health: Object.freeze({ property: 'Host-filtered browser WebSocket proxy accepts the configured authority.',
            probe, tool_probe: probe, interval_seconds: 5, timeout_seconds: 10, retries: 12,
            start_period_seconds: Math.max(10, Math.ceil(healthMeasurement.duration_seconds)),
            measurement: healthMeasurement }), toolchain_pins: Object.freeze([]), provenance,
    }), authority: Object.freeze({
        serviceId: 'cockpit-browser-runner' as const, hostVariable, proxyPort: browser.proxy.proxyPort,
        manifest: Object.freeze({ path: manifestPath, sha256: manifest.sha256, identity: sourceIdentity(manifest.identity),
            provenance: 'declared' as const, reason }),
        lockfile: Object.freeze({ path: browser.project.lockfile, sha256: lockfile.sha256, identity: sourceIdentity(lockfile.identity) }),
    }) })
}

async function retainedPortLease(
    config: DerivedRegistry['config'],
    checkout: GeneratedCheckoutIdentity,
    currentStack: ReturnType<typeof stackId>,
): Promise<PortLeaseProjection | undefined> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined
    const namespace = await selectStateRoot({ platform: process.platform, home: process.env.HOME,
        xdgStateHome: process.env.XDG_STATE_HOME,
        checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath], cockpitId: checkout.cockpitId })
    if (namespace.kind !== 'complete') return undefined
    const stored = await readState(namespace.value.paths.lifecycle(currentStack))
    if (stored.kind !== 'complete') return undefined
    const lifecycle = decodeLifecycleRecord(stored.value, { cockpitId: checkout.cockpitId, stackId: currentStack })
    if (!lifecycle) return undefined
    const retained = await observeRetainedPortFamily({ namespace: namespace.value, stackId: currentStack,
        holderId: lifecycle.value.holderId, checkoutId: checkout.checkoutId, config: config.ports })
    if (retained.kind !== 'complete') return undefined
    const entrypoints = deriveEntrypoints({ lease: retained.lease, declarations: config.environment.entrypoint_derivatives })
    if (entrypoints.kind !== 'complete') return undefined
    return projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })
}

async function prepare(input: unknown, adapters: GeneratedEnvironmentCommandAdapters, portLease?: PortLeaseProjection): Promise<PreparedEnvironment | RefusalOutcome> {
    const request = commandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const loaded = await loadCockpitConfig(request.configPath)
    if (loaded.kind !== 'complete') return Object.freeze({
        kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: Object.freeze([...loaded.diagnostics]),
    })
    const workProjection = projectWorkEnvironmentConfig(loaded.result)
    const workEnvironment = workProjection && consumeWorkEnvironmentConfigProjection(workProjection)
    if (!workEnvironment || workEnvironment.source.path !== loaded.result.source.path
        || workEnvironment.source.sha256 !== loaded.result.source.sha256) {
        return refuse('GENERATED_RENDER_UNAUTHENTICATED', 'the work environment configuration could not be consumed', loaded.result.source.path)
    }
    const derived = deriveRegistry(loaded.result.config)
    if (derived.kind !== 'complete') return refuse(derived.code, derived.message, loaded.result.source.path)
    const config = derived.result.config
    // Without a generated declaration nothing environment-shaped is rendered or owned here: the
    // cockpit either runs its own Compose files or declares no runtime, and still gets its surfaces.
    const declaration = config.environment.generated
    if (!declaration && workEnvironment.browser && Object.hasOwn(workEnvironment.browser, 'endpoint')) return refuse(
        'GENERATED_DECLARATION_MISSING',
        'a remote browser runner is rendered into the generated environment, and this configuration declares none',
        'browser',
        'declare [environment.generated] for the runner, or remove browser.endpoint',
    )
    const root = dirname(loaded.result.source.path)
    const authenticatedSiblings = await authenticateSiblingRoots(root, derived.result.config)
    if (authenticatedSiblings.kind === 'refusal') return refuse(
        'GENERATED_SIBLING_ROOT_INVALID',
        authenticatedSiblings.reason,
        'sibling',
    )
    const siblingRoots = authenticatedSiblings.roots
    const runtimeCheckout = declaration || workEnvironment.browser || config.environment.compose_files.length > 0
        ? await observeGeneratedCheckoutIdentity({ source: loaded.result.source, cockpitName: config.cockpit.name,
            env: process.env }) : undefined
    if (runtimeCheckout?.state === 'failed') return refuse('GENERATED_INPUT_INVALID',
        `generated checkout identity is unavailable: ${runtimeCheckout.reason}`, loaded.result.source.path,
        'restore the configuration checkout and Git installation, then run cockpit sync --config <file>')
    const currentCockpit = runtimeCheckout?.cockpitId ?? cockpitId({ name: config.cockpit.name, mainCheckoutPath: root })
    const publishedCockpit = publicationCockpitId({ name: config.cockpit.name })
    const currentCheckout = runtimeCheckout?.checkoutId ?? checkoutId({ checkoutPath: root })
    const currentStack = stackId({ cockpitId: currentCockpit, checkoutId: currentCheckout, variant: { kind: 'shared' } })
    const suppliedPorts = portLease === undefined ? undefined : inspectPortLeaseProjection(portLease)
    if (portLease !== undefined && (!suppliedPorts || suppliedPorts.lease.stackId !== currentStack)) {
        return refuse('GENERATED_INPUT_INVALID', 'the generated environment port lease authority is invalid', 'browser')
    }
    const generation = sha256(`generated-environment\0${loaded.result.source.sha256}`)
    const node = await nodeAuthority()
    if (!node) return refuse(
        'GENERATED_EXECUTABLE_UNAVAILABLE',
        'the current Node executable could not be authenticated',
        process.execPath,
    )
    const browserRunner = declaration
        ? await projectBrowserRunner(workEnvironment, declaration, config.ports.bases, root, node, adapters) : undefined
    if (browserRunner && 'kind' in browserRunner) return refuse('GENERATED_DECLARATION_INVALID', browserRunner.message, 'browser')
    const projectedRunner = browserRunner && !('kind' in browserRunner) ? browserRunner : undefined
    const inspectedPorts = suppliedPorts ?? (projectedRunner && runtimeCheckout
        ? await retainedPortLease(config, runtimeCheckout, currentStack)
        : undefined)
    if (projectedRunner && !inspectedPorts) return refuse(
        'GENERATED_INPUT_INVALID',
        'configured remote browser publication requires an authenticated current port lease',
        'browser',
    )
    const hostInputRoots: Record<string, GeneratedHostInputRoot> = {}
    for (const service of declaration?.services ?? []) {
        if (!service.mounts.some(mount => mount.kind !== 'volume') && service.toolchain_pins.length === 0) continue
        const sibling = siblingRoots.siblings.get(service.sibling)
        if (!sibling) return refuse('GENERATED_SIBLING_ROOT_INVALID', 'a generated service names an unauthenticated sibling', service.id)
        hostInputRoots[service.id] = Object.freeze({ path: sibling.root, ...sibling.identity })
    }
    if (projectedRunner) {
        const status = await lstat(root)
        if (!status.isDirectory() || status.isSymbolicLink() || await realpath(root) !== root) return refuse(
            'GENERATED_SIBLING_ROOT_INVALID', 'the browser input root is not a canonical ordinary directory', 'browser')
        hostInputRoots[projectedRunner.service.id] = Object.freeze({ path: root, dev: status.dev, ino: status.ino })
    }
    const hostInputs: GeneratedHostInput[] = []
    for (const service of [...declaration?.services ?? [], ...projectedRunner ? [projectedRunner.service] : []]) {
        const sibling = siblingRoots.siblings.get(service.sibling)
        const inputRoot = hostInputRoots[service.id] ?? (sibling ? Object.freeze({ path: sibling.root, ...sibling.identity }) : undefined)
        if (!inputRoot) return refuse('GENERATED_SIBLING_ROOT_INVALID', 'a generated service names an unauthenticated sibling', service.id)
        for (const mount of service.mounts) {
            if (mount.kind !== 'volume') hostInputs.push(Object.freeze({
                root: inputRoot, source: mount.source, type: mount.source_type!, mount: true,
            }))
        }
        if ('build' in service && service.build) hostInputs.push(
            Object.freeze({ root: inputRoot, source: service.build.context, type: 'directory', mount: false }),
            Object.freeze({ root: inputRoot, source: join(service.build.context, service.build.dockerfile ?? 'Dockerfile'), type: 'file', mount: false }),
        )
    }
    const rendered = declaration ? renderGeneratedEnvironment({
        declaration,
        sourceSha256: loaded.result.source.sha256,
        generation,
        stackId: currentStack,
        cockpitId: currentCockpit,
        portDefaults: config.ports.bases,
        siblingDirectories: Object.fromEntries([...siblingRoots.siblings].map(([slug, sibling]) =>
            [slug, relative(root, sibling.root) || '.'])),
        ...(projectedRunner ? { browserRunner: { service: projectedRunner.service } } : {}),
    }) : undefined
    if (rendered && rendered.kind !== 'complete') return refuse(rendered.code, rendered.reason, loaded.result.source.path)
    const generatedComposeAuthority = rendered && projectGeneratedComposeArtifactAuthority(rendered)
    if (rendered && !generatedComposeAuthority) return refuse(
        'GENERATED_RENDER_UNAUTHENTICATED',
        'the generated Compose authority could not be issued',
        loaded.result.source.path,
    )
    let composeOwnership: OwnedBytes | undefined
    if (!declaration && config.environment.compose_files.length > 0) {
        const sources = []
        for (const reference of config.environment.compose_files) {
            const read = await readAnchoredFile(root, reference, COMPOSE_SOURCE_BYTES, node, adapters)
            if (read.kind !== 'complete') return refuse('GENERATED_PATH_UNSAFE',
                'a declared Compose file is missing, unreadable, or crosses a symbolic-link boundary', reference)
            sources.push({ reference, source: read.bytes.toString('utf8') })
        }
        const ownership = renderComposeOwnership({ sources, stackId: currentStack, cockpitId: currentCockpit,
            configSha256: loaded.result.source.sha256 })
        if (ownership.kind !== 'complete') return refuse('GENERATED_DECLARATION_INVALID',
            `the ownership override cannot be rendered from environment.compose_files: ${ownership.reason}`, ownership.target)
        composeOwnership = Object.freeze({ path: COMPOSE_OWNERSHIP_FILE, bytes: ownership.bytes, sha256: sha256(ownership.bytes) })
    }
    const generated = Object.freeze([
        ...(rendered?.manifest ?? []).map(({ path, bytes, sha256: digest }) => Object.freeze({ path, bytes, sha256: digest })),
        ...(composeOwnership ? [composeOwnership] : []),
    ])
    // The anchored source read pins the publication root's identity for the whole sync. A stack
    // without fixtures has no persona source, so the configuration file itself is the anchor.
    const fixtures = declaration?.data?.fixtures
    const sourcePath = fixtures?.persona_source ?? relative(root, loaded.result.source.path)
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
    const persona = fixtures && declaration ? projectPersonaOutputs(
        declaration,
        { path: sourcePath, bytes: source.bytes },
        (output, bytes) => renderPersona(output.format, bytes),
    ) : Object.freeze({ source: Object.freeze({ path: sourcePath, sha256: source.sha256 }), outputs: Object.freeze([]) })
    if (!persona) return refuse('GENERATED_PERSONA_INVALID', 'the declared persona projection is invalid', sourcePath)
    const personaFiles = persona.outputs.map((output) => Object.freeze({
        path: output.path,
        bytes: Buffer.from(output.bytesBase64, 'base64').toString('utf8'),
        sha256: output.sha256,
    }))
    // The secrets directory holds the generated stack's resolver material; without one there is none to keep out of Git.
    const secretFiles = declaration
        ? [Object.freeze({ path: SECRET_IGNORE_PATH, bytes: SECRET_IGNORE_BYTES, sha256: sha256(SECRET_IGNORE_BYTES) })] : []
    const secretRoot = resolve(root, dirname(SECRET_IGNORE_PATH))
    if (declaration) try {
        const status = await lstat(secretRoot)
        if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o700) {
            return refuse('GENERATED_PATH_UNSAFE', 'the central secrets directory must be a mode-0700 non-symbolic directory', dirname(SECRET_IGNORE_PATH))
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return refuse('GENERATED_PATH_UNSAFE', 'the central secrets directory could not be authenticated', dirname(SECRET_IGNORE_PATH))
        }
    }
    const owned = Object.freeze([...generated, ...personaFiles, ...secretFiles].sort((left, right) => compareCodeUnits(left.path, right.path)))
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
    const canonical = rendered && inspectGeneratedEnvironment({
        rendered,
        candidates: generated.map(({ path, bytes }) => ({ path, bytes })),
        now,
    })
    if (canonical && canonical.kind !== 'passed') return refuse(canonical.code, canonical.reason, canonical.target)
    return Object.freeze({
        root,
        cockpitId: publishedCockpit,
        stackId: currentStack,
        ...(runtimeCheckout ? { runtimeCheckout } : {}),
        configPath: loaded.result.source.path,
        sourceSha256: loaded.result.source.sha256,
        personaSource: Object.freeze({ path: sourcePath, sha256: persona.source.sha256 }),
        personaSourceIdentity: source.identity,
        generation,
        ...(rendered && generatedComposeAuthority && canonical ? { rendered, generatedComposeAuthority, inspection: canonical } : {}),
        generated,
        persona: Object.freeze(personaFiles),
        owned,
        surfaces: Object.freeze([]),
        compactSurfacePaths: new Set<string>(),
        configuredHarnesses: Object.freeze([...SURFACE_TARGETS]),
        activeSurfaceOverrides: Object.freeze([]),
        changedOverrideOriginals: Object.freeze([]),
        guideSources: Object.freeze({ requests: Object.freeze([]), observations: Object.freeze([]), missing: Object.freeze([]) }),
        sourceEvidence: Object.freeze([]),
        sourceRoots: Object.freeze([]),
        customSources: Object.freeze([]),
        adoptedSources: Object.freeze([]),
        surfaceAssets: Object.freeze([]),
        warnings: Object.freeze([]),
        registry: derived.result,
        siblingRoots,
        hostInputRoots: Object.freeze(hostInputRoots),
        hostInputs: Object.freeze(hostInputs),
        workEnvironment,
        ...(projectedRunner ? { browserRunner: projectedRunner.authority } : {}),
        ...(inspectedPorts ? { portLease: inspectedPorts } : {}),
        node,
        now,
        producedAt,
    })
}

function expectedSurfaceOutputs(
    features: readonly SurfaceFeature[],
    sources: readonly SurfaceSourceFile[],
): Readonly<Record<SurfaceTarget, readonly string[]>> {
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
    return Object.freeze(Object.fromEntries(SURFACE_TARGETS.map(target => [target, Object.freeze([...new Set(rows[target])].sort(compareCodeUnits))]))) as Readonly<Record<SurfaceTarget, readonly string[]>>
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
    return Object.freeze([...new Set(rows)].sort(compareCodeUnits))
}

function claudePluginManifest(): Readonly<{ bytes: string; sha256: string }> {
    const bytes = `${JSON.stringify({
        name: 'cockpit-surfaces',
        description: 'Generated cockpit agent surfaces.',
    }, null, 2)}\n`
    return Object.freeze({ bytes, sha256: sha256(bytes) })
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
    } catch { return false }
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
    return Object.freeze({
        kind: 'complete', status: 0, diagnostics: Object.freeze([]) as readonly [],
        mechanism: Object.freeze({ package: 'rulesync', version: '43.1.2', role: 'spelling' }),
        files: Object.freeze([]),
    })
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
        return Object.freeze({ path, bytes: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes),
            sha256: read.sha256, identity: read.identity })
    } catch { return undefined }
}

/**
 * Claude Code's native Read, Grep and Glob tools never reach the guard hook, so the read denial the
 * hook applies to shell commands is restated as Claude `Read` deny rules. Siblings sit outside the
 * project root, where neither `./`, `/..` nor `../` rules match and an absolute path would differ
 * per clone, so each rule is anchored with `//**` on the sibling-relative suffix. Measured on Claude
 * Code 2.1.314, 2026-10-30, with an unruled control file beside them: `//**` rules refused Read and
 * Grep of sibling instances and of nested `.secrets` files while the control stayed readable.
 * Over-matching a deny is safe; glob metacharacters in a path become `?` so a literal bracket
 * cannot narrow the rule.
 */
function claudeReadDenials(
    grants: readonly { slug: string; target: SurfaceTarget; path: string }[],
    instances: readonly { slug: string; path: string }[],
): readonly string[] {
    const literal = (path: string) => path.replace(/[*?[\]\\!#()]/g, '?')
    const rules = ['//**/.secrets/**']
    for (const instance of instances) {
        const grant = grants.find(row => row.target === 'claudecode' && row.slug === instance.slug)
        if (!grant) continue
        const suffix = [...grant.path.split('/'), ...instance.path.split('/')].filter(part => part !== '..' && part !== '.' && part !== '')
        rules.push(`//**/${literal(suffix.join('/'))}`)
    }
    return [...new Set(rules)].sort(compareCodeUnits)
}

function nativeSources(
    mcp: Extract<McpCollectionOutcome, { kind: 'complete' }>,
    grants: readonly { slug: string; target: SurfaceTarget; path: string }[],
    instances: readonly { slug: string; path: string }[],
): readonly SurfaceSourceFile[] {
    const sources: SurfaceSourceFile[] = []
    if (mcp.result.servers.length > 0) {
        const transports = mcp.result.harnesses.flatMap(row => row.servers)
        const servers = Object.fromEntries(mcp.result.servers.map(model => transports.find(server => server.name === model.name)!).map(server => [server.name, {
            type: 'stdio', command: server.command, args: server.args, cwd: server.cwd, disabled: !server.enabled,
        }]))
        const targets = Object.fromEntries(mcp.result.harnesses.flatMap(row => {
            const removed = mcp.result.servers.filter(server => !row.servers.some(transport => transport.name === server.name))
            return removed.length ? [[harnessFact(row.target).rulesyncTarget, {
                mcpServers: Object.fromEntries(removed.map(server => [server.name, null])),
            }]] : []
        }))
        sources.push(Object.freeze({ path: 'mcp.jsonc', bytes: `${JSON.stringify({ mcpServers: servers, ...targets }, null, 2)}\n` }))
    }
    const paths = (target: SurfaceTarget) => [...new Set(grants.filter(grant => grant.target === target).map(grant => grant.path))].sort(compareCodeUnits)
    const enabledMcpjsonServers = mcp.result.harnesses.find(row => row.target === 'claudecode')!.servers
        .filter(server => server.enabled).map(server => server.name).sort()
    sources.push(Object.freeze({ path: 'permissions.jsonc', bytes: `${JSON.stringify({
        permission: {},
        claudecode: {
            permission: { read: Object.fromEntries(claudeReadDenials(grants, instances).map(rule => [rule, 'deny'])) },
            permissions: { additionalDirectories: paths('claudecode') },
            enabledMcpjsonServers,
        },
        opencode: {
            permission: { external_directory: Object.fromEntries(paths('opencode').map(path => [`${path}/**`, 'allow'])) },
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
    }, null, 2)}\n` }))
    return Object.freeze(sources)
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
        return row ? Object.freeze({ target: target as SurfaceTarget, path, baseSha256: row.sha256, bytes: row.bytes, sha256: row.sha256 }) : undefined
    })
    if (fragments.some(fragment => fragment === undefined)) return undefined
    return Object.freeze({ modelSha256, fragments: Object.freeze(fragments as NonNullable<typeof fragments[number]>[]) })
}

function nativeGrantFragmentSet(
    generated: Extract<SurfaceGenerationOutcome, { kind: 'complete' }>,
    grants: readonly Readonly<{ target: SurfaceTarget; path: string }>[],
    paths: Readonly<Partial<Record<SurfaceTarget, string>>>,
): NativeFragmentSet | undefined {
    const modelSha256 = surfaceModelSha256(grants)
    if (!modelSha256) return undefined
    const fragments = Object.entries(paths).map(([target, path]) => {
        const row = generated.files.find(candidate => candidate.target === target && candidate.path === path)
        if (target !== 'opencode' && target !== 'codexcli') {
            return row ? Object.freeze({ target: target as SurfaceTarget, path, baseSha256: row.sha256, bytes: row.bytes, sha256: row.sha256 }) : undefined
        }
        if (target === 'codexcli') {
            let base: Record<string, unknown> = {}
            if (row) {
                try {
                    const parsed = ownRecord(parseToml(row.bytes))
                    if (!parsed) return undefined
                    base = parsed
                } catch { return undefined }
                if (['sandbox_mode', 'sandbox_workspace_write', 'default_permissions', 'permissions']
                    .some(key => Object.hasOwn(base, key))) return undefined
            }
            // Codex permission profiles reject the `..` segment required by a portable sibling
            // grant. Publish the core-owned workspace-write settings alone: mixing the legacy
            // sandbox with a generated profile would make Codex ignore that profile.
            const writableRoots = [...new Set(grants.filter(grant => grant.target === target)
                .map(grant => grant.path))].sort(compareCodeUnits)
            const bytes = stringifyToml({ ...base, sandbox_mode: 'workspace-write', sandbox_workspace_write: { writable_roots: writableRoots } })
            return Object.freeze({ target: target as SurfaceTarget, path, baseSha256: row?.sha256 ?? sha256(''), bytes, sha256: sha256(bytes) })
        }
        let base: Record<string, unknown> = {}
        if (row) {
            try {
                const parsed = ownRecord(JSON.parse(row.bytes))
                if (!parsed) return undefined
                base = parsed
            } catch { return undefined }
            if (Object.hasOwn(base, 'permission')) return undefined
        }
        const externalDirectory = Object.fromEntries([...new Set(grants.filter(grant => grant.target === target)
            .map(grant => `${grant.path}/**`))].sort(compareCodeUnits).map(grantPath => [grantPath, 'allow']))
        const bytes = `${JSON.stringify({ ...base, permission: { external_directory: externalDirectory } }, null, 2)}\n`
        return Object.freeze({ target: target as SurfaceTarget, path, baseSha256: row?.sha256 ?? sha256(''), bytes, sha256: sha256(bytes) })
    })
    if (fragments.some(fragment => fragment === undefined)) return undefined
    return Object.freeze({ modelSha256, fragments: Object.freeze(fragments as NonNullable<typeof fragments[number]>[]) })
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
    return Object.freeze({ ...mcp, fragments: Object.freeze(mcp.fragments.map(fragment => {
        const grant = replacements.get(`${fragment.target}\0${fragment.path}`)
        return grant ? Object.freeze({ ...fragment, bytes: grant.bytes, sha256: grant.sha256 }) : fragment
    })) })
}

function nativeMcpPaths(targets: readonly SurfaceTarget[]): Readonly<Partial<Record<SurfaceTarget, string>>> {
    return Object.freeze(Object.fromEntries(targets.map(target => [target, harnessFact(target).outputs.mcp])))
}

function nativeGrantPaths(targets: readonly SurfaceTarget[]): Readonly<Partial<Record<SurfaceTarget, string>>> {
    return Object.freeze(Object.fromEntries(targets.map(target => [target, harnessFact(target).outputs.permissions[0]])))
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
const safe = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..' && !['.git','node_modules'].includes(part.toLowerCase()));
(async () => {
  const source = fs.readFileSync(process.argv[2]);
  if (digest(source) !== request.sourceSha256) throw new Error('module changed');
  const imported = await import('data:text/javascript;base64,' + source.toString('base64'));
  const fn = imported[request.export]; if (typeof fn !== 'function') throw new Error('export');
  const result = await fn(request.input);
  if (!own(result) || Object.keys(result).sort().join(',') !== 'files,kind' || result.kind !== 'complete' || !Array.isArray(result.files) || result.files.length === 0 || result.files.length > 256) throw new Error('result');
  let total = 0; let spelling = false; const files = [];
  for (const [index, file] of result.files.entries()) {
    if (!own(file) || Object.keys(file).sort().join(',') !== 'bytes,path,scope,sha256' || !safe(file.path) || typeof file.bytes !== 'string' || Buffer.byteLength(file.bytes) > 65536 || digest(file.bytes) !== file.sha256 || !['always','scoped'].includes(file.scope)) throw new Error('file');
    spelling = spelling || file.path === request.spelling || file.bytes.includes(request.spelling);
    total += Buffer.byteLength(file.bytes); if (total > 4194304) throw new Error('limit');
    const output = path.join(request.output, String(index)); fs.writeFileSync(output, file.bytes, { flag: 'wx', mode: 0o600 });
    files.push({ path: file.path, sha256: file.sha256, scope: file.scope, output: String(index) });
  }
  if (!spelling) throw new Error('spelling');
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
        evidenceSource = Object.freeze({ harness, feature: capability.feature, path: capability.evidence.reference,
            sha256: evidenceRead.sha256, identity: evidenceRead.identity, maxBytes: MAX_SURFACE_FILE_BYTES })
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
        scratchIdentity = Object.freeze({ dev: scratchStatus.dev, ino: scratchStatus.ino })
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
            descriptors.push(Object.freeze({ path: row.path, sha256: row.sha256, scope: row.scope, output: row.output }))
        }
        const reads = await readAnchoredBatches(scratch, descriptors.map(row => Object.freeze({
            path: row.output, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
        })), prepared.node, adapters)
        if (!reads || reads.kind !== 'complete' || reads.results.length !== descriptors.length) return undefined
        const files: CustomSurfaceReceipt['files'][number][] = []
        for (const [index, row] of descriptors.entries()) {
            const read = reads.results[index]!
            if (read.kind !== 'complete' || read.sha256 !== row.sha256
                || read.identity.root.dev !== scratchIdentity.dev || read.identity.root.ino !== scratchIdentity.ino) return undefined
            const bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
            files.push(Object.freeze({ path: row.path, bytes, sha256: row.sha256, scope: row.scope }))
        }
        if (files.length === 0 || !files.some(file => file.path === capability.spelling || file.bytes.includes(capability.spelling))) return undefined
        const resultSha256 = surfaceModelSha256(files)
        if (!resultSha256) return undefined
        return Object.freeze({
            receipt: Object.freeze({ harness, feature: capability.feature, state: capability.state, measuredOn: capability.measured_on,
                module: capability.mechanism.module, export: capability.mechanism.export, sourceSha256: moduleRead.sha256,
                resultSha256, files: Object.freeze(files) }),
            sources: Object.freeze([
                Object.freeze({ harness, feature: capability.feature, path: capability.mechanism.module,
                    sha256: moduleRead.sha256, identity: moduleRead.identity, maxBytes: MAX_GENERATED_BYTES }),
                ...(evidenceSource ? [evidenceSource] : []),
            ]),
            ...(capability.state === 'enforced' ? { evidence: Object.freeze({ ...capability.evidence }) } : {}),
        })
    } catch { return undefined } finally {
        if (scratch && scratchIdentity) {
            try {
                const current = await lstat(scratch)
                if (current.isDirectory() && !current.isSymbolicLink()
                    && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino) {
                    await rm(scratch, { recursive: true, force: true })
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
    try { policyBytes = new TextDecoder('utf-8', { fatal: true }).decode(policyRead.bytes) } catch { return undefined }
    const policy: NativeHookPolicy = Object.freeze({
        manifest,
        authority: Object.freeze({ root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath }),
        declarations: Object.freeze([]),
        path: policyDeclaration.path,
        exists: true,
        bytes: policyBytes,
    })
    const source = Object.freeze({ path: policyDeclaration.path, sha256: policyRead.sha256, identity: policyRead.identity })
    const git = await resolveGitExecutable(process.env)
    if (git.state !== 'available') return Object.freeze({
        projection: Object.freeze({ kind: 'refusal' as const, reason: git.reason }),
        source,
    })
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
    try { revisions = new TextDecoder('utf-8', { fatal: true }).decode(revisionOutcome.stdout).trim().split('\n') } catch { return undefined }
    if (revisions.length !== 2 || revisions[0] === revisions[1]
        || revisions.some(value => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) || !/[1-9a-f]/.test(value))) return undefined
    let scratch: string | undefined
    let scratchIdentity: DirectoryIdentity | undefined
    try {
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-native-hook-cost-')))
        const status = await lstat(scratch)
        if (!status.isDirectory() || status.isSymbolicLink()) return undefined
        scratchIdentity = Object.freeze({ dev: status.dev, ino: status.ino })
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
                        timeoutMs: HELPER_TIMEOUT_MS,
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
                    if (!step) throw new Error('native hook cost measurement could not be admitted')
                    return step
                },
            },
        })
        return Object.freeze({
            projection,
            source,
        })
    } finally {
        if (scratch && scratchIdentity) {
            try {
                const current = await lstat(scratch)
                if (current.isDirectory() && !current.isSymbolicLink()
                    && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino) {
                    await rm(scratch, { recursive: true, force: true })
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
        }
    }
}

function bindBrowserMcpDeclaration(
    declaration: McpDeclaration,
    configuredEndpoint: string,
    boundEndpoint: string,
): McpDeclaration | undefined {
    const indexes = declaration.args.flatMap((value, index) => value === configuredEndpoint ? [index] : [])
    if (indexes.length !== 1) return undefined
    return Object.freeze({ ...declaration,
        args: declaration.args.map((value, index) => index === indexes[0] ? boundEndpoint : value) })
}

async function prepareSurfaces(
    prepared: PreparedEnvironment,
    priorOwned: readonly SurfacePriorOwnedEntry[],
    adapters: GeneratedEnvironmentCommandAdapters,
    manifest?: OwnershipManifest,
): Promise<PreparedEnvironment | RefusalOutcome> {
    const config = prepared.registry.config
    const profiles = [...prepared.rendered?.replay.profiles ?? []]
    const selected = config.sibling.filter(row => row.mount === 'always'
        || row.mount.startsWith('profile:') && profiles.includes(row.mount.slice('profile:'.length)))
    const requiredSlugs = new Set([...selected.map(row => row.slug), ...prepared.registry.mcpSources.map(row => row.slug)])
    const siblingRoots = new Map<string, string>()
    const sourceRoots: SourceRootIdentity[] = []
    if (!await siblingRootsCurrent(prepared.siblingRoots)) return refuse(
        'GENERATED_SIBLING_ROOT_INVALID', 'a sibling directory changed after its root authority was authenticated', 'sibling',
    )
    try {
        for (const sibling of config.sibling.filter(row => requiredSlugs.has(row.slug))) {
            const authority = prepared.siblingRoots.siblings.get(sibling.slug)
            if (!authority) throw new Error('root')
            const root = authority.root
            const status = await lstat(root)
            if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('root')
            siblingRoots.set(sibling.slug, root)
            sourceRoots.push(Object.freeze({ slug: sibling.slug, root, identity: authority.identity }))
        }
    } catch {
        return refuse('SURFACE_SOURCE_UNAVAILABLE', 'an active sibling checkout could not be authenticated', 'surfaces')
    }
    // A root guide that projection also writes would become both an authenticated input and an
    // owned output. Native harness loading already reaches these files, so a self-link adds no rule.
    const rootInstructionOutputs = new Set(['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'opencode.jsonc'])
    const projectionGuides = (sibling: typeof config.sibling[number]): readonly string[] =>
        siblingRoots.get(sibling.slug) === prepared.root
            ? sibling.guides.filter(guide => !rootInstructionOutputs.has(guide))
            : sibling.guides
    const guideRequests = selected.flatMap(sibling => projectionGuides(sibling).map(guide => Object.freeze({
        slug: sibling.slug, root: siblingRoots.get(sibling.slug)!, sourcePath: resolve(siblingRoots.get(sibling.slug)!, guide),
    }))).sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath))
    const observedGuides = guideRequests.length === 0
        ? { kind: 'complete' as const, observations: Object.freeze([]) as readonly GuideObservation[], missing: Object.freeze([]) as readonly string[] }
        : await observeSiblingGuides({ allowedRoots: selected.map(row => siblingRoots.get(row.slug)!), requests: guideRequests })
    if (observedGuides.kind !== 'complete') return refuse(observedGuides.diagnostic.code, observedGuides.diagnostic.message, observedGuides.diagnostic.target)
    const projectionInput: ProjectionPlannerInput = {
        canonicalMainCheckout: prepared.root,
        siblingsRoot: config.cockpit.siblings_root,
        activeProfiles: profiles,
        guideCapLines: config.cockpit.guide_cap,
        siblings: config.sibling.map(row => ({ slug: row.slug, mount: row.mount, directoryAuthority: row.dir, guides: [...projectionGuides(row)] })),
        mountedPaths: selected.map(row => ({ slug: row.slug, path: siblingRoots.get(row.slug)! })),
        directoryGrants: selected.flatMap(row => SURFACE_TARGETS.map(target => ({ slug: row.slug, target, path: siblingRoots.get(row.slug)! }))),
        guideObservations: observedGuides.observations,
        existingEntries: [],
        priorOwnedLinks: priorOwned.filter((row): row is Extract<SurfacePriorOwnedEntry, { kind: 'symlink' }> => row.kind === 'symlink')
            .map(row => ({ path: row.path, target: row.target })),
        standingSources: [],
        loadCharacterizations: {
            claudecode: { measuredOn: '2026-09-26', provenance: 'paired source-estate rule-loading measurement', metric: 'lines', scopeSemantics: 'conditional' },
            codexcli: { measuredOn: '2026-09-26', provenance: 'root AGENTS loading measurement', metric: 'lines', scopeSemantics: 'full' },
            opencode: { measuredOn: '2026-09-26', provenance: 'instructions-list loading measurement', metric: 'lines', scopeSemantics: 'full' },
        },
    }
    let projection = planSiblingProjection(projectionInput)
    if (projection.kind !== 'complete') return refuse(projection.diagnostic.code, projection.diagnostic.message, projection.diagnostic.target)

    const evidence: SurfaceInputEvidence[] = observedGuides.observations.map(row => Object.freeze({
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
            return refuse('MCP_DECLARATION_INVALID', 'an MCP declaration source is not UTF-8', source.path)
        }
        const parsed = parseMcpDeclarationFile({ bytes, source: { kind: 'sibling', slug: source.slug, path: source.path, sha256: read.sha256 }, workingDirectory: root })
        if (parsed.kind !== 'complete') return refuse(parsed.diagnostic.code, parsed.diagnostic.message, source.path)
        declarations.push(...parsed.declarations)
        evidence.push(Object.freeze({ kind: 'mcp' as const, root, path: source.path, sha256: read.sha256, identity: sourceIdentity(read.identity) }))
    }
    let mcp = collectMcpDeclarations({ cockpitDirectory: prepared.root, declarations, approved: config.mcp.approved, targets: SURFACE_TARGETS })
    if (mcp.kind !== 'complete') return refuse(mcp.diagnostic.code, mcp.diagnostic.message, mcp.diagnostic.server)
    if (mcp.diagnostics.some(row => row.code === 'MCP_APPROVAL_UNKNOWN')) {
        const row = mcp.diagnostics.find(candidate => candidate.code === 'MCP_APPROVAL_UNKNOWN')!
        return refuse(row.code, row.message, row.server)
    }

    const assetPaths = [EVALUATOR_ASSET, ...SKILL_ASSETS, ...REFERENCE_ASSETS, ...RESTRICTION_ASSETS, ...WORK_ASSETS]
    const assetReads = await readAnchoredBatches(SURFACE_ROOT, assetPaths.map(path => Object.freeze({
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
        if (playwright.length !== 1 || !config.mcp.approved.includes('playwright')) {
            return refuse('MCP_DECLARATION_INVALID', 'browser surfaces require one approved authenticated Playwright declaration', 'playwright')
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
                postures: Object.freeze({ authorities: Object.freeze([authority]), stages: Object.freeze([stage.authority]) }),
            }, namespace.value)
            const runtime = prepared.browserRunner
                ? prepared.portLease && bindBrowserRuntimePortLease(configuredRuntime, prepared.portLease)
                : configuredRuntime
            if (!runtime) throw new Error('browser runtime could not be bound to the authenticated port lease')
            if (prepared.browserRunner && runtime.connection.kind !== 'remote') {
                throw new Error('browser runtime did not retain a remote endpoint after port binding')
            }
            const browserMcp = prepared.browserRunner && runtime.connection.kind === 'remote'
                ? bindBrowserMcpDeclaration(playwright[0]!, browserConfiguration.endpoint!, runtime.connection.endpoint)
                : playwright[0]!
            if (!browserMcp) throw new Error('browser MCP declaration does not contain exactly one configured endpoint argument')
            const browserSkill = asset('skills/cockpit-browser.skill.md')
            browser = renderBrowserSurfaces({
                runtime,
                cockpitDirectory: prepared.root,
                harnesses: browserConfiguration.harnesses.flatMap(row => isGuardSurfaceTarget(row.target)
                    ? [Object.freeze({ target: row.target, version: row.version })] : []),
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
                approved: config.mcp.approved.filter(name => name !== 'playwright' || browserTargets.size > 0),
                targets: SURFACE_TARGETS,
            })
            if (boundMcp.kind !== 'complete') throw new Error(`bound browser MCP declaration was refused: ${boundMcp.diagnostic.code}`)
            mcp = Object.freeze({ ...boundMcp, result: Object.freeze({ ...boundMcp.result,
                harnesses: Object.freeze(boundMcp.result.harnesses.map(row => Object.freeze({ ...row,
                    servers: Object.freeze(row.servers.filter(server => server.name !== 'playwright' || browserTargets.has(row.target))),
                }))),
            }) })
            const runnerAsset = asset('scripts/browser-runner.sh')
            const debuggerPreparation: BrowserDebuggerPreparation | undefined = prepared.browserRunner && browserConfiguration.headed
                ? Object.freeze({
                    kind: 'foreground-browser-debugger' as const,
                    cwd: prepared.root,
                    launcher: Object.freeze({ path: resolve(prepared.root, '.cockpit/browser/runner.sh'), sha256: runnerAsset.sha256 }),
                    argv: Object.freeze([
                        '/bin/sh', resolve(prepared.root, '.cockpit/browser/runner.sh'), 'debugger',
                        '--manifest', resolve(prepared.root, prepared.browserRunner.manifest.path),
                        '--lockfile', resolve(prepared.root, prepared.browserRunner.lockfile.path),
                        '--manifest-sha256', prepared.browserRunner.manifest.sha256,
                        '--lock-sha256', prepared.browserRunner.lockfile.sha256,
                        '--driver-version', browserConfiguration.project.driverVersion,
                        '--server-port', String(browserConfiguration.proxy.serverPort), '--proxy-port', '0',
                        '--max-clients', String(runtime.server.maxClients),
                        '--artifacts', resolve(prepared.root, browserConfiguration.artifacts.debugger),
                        ...browserConfiguration.proxy.allowedHosts.flatMap(host => ['--allowed-host', host]),
                        ...browserConfiguration.resolver.flatMap(({ hostname, address }) => ['--resolver-rule', `MAP ${hostname} ${address}`]),
                        '--engine', browserConfiguration.engine, '--deadline-seconds', '3600',
                    ]),
                    deadlineSeconds: 3600,
                    foreground: true as const,
                }) : undefined
            if (debuggerPreparation) issuedBrowserDebuggerPreparations.set(debuggerPreparation, runtime)
            const runner = prepared.browserRunner && debuggerPreparation ? Object.freeze({
                ...prepared.browserRunner,
                debugger: debuggerPreparation,
            }) : prepared.browserRunner
            browserAuthority = Object.freeze({
                runtime,
                namespace: namespace.value,
                mcp: browserMcp,
                skillTemplate: browserSkill,
                ...(runner ? { runner } : {}),
            })
        } catch (error) {
            return refuse('SURFACE_INPUT_INVALID', `browser surface projection was refused: ${error instanceof Error ? error.message : String(error)}`, 'browser')
        }
    }
    const testingRegistry = prepared.workEnvironment.testing
        ? createGateRegistry(prepared.workEnvironment.testing.declarations)
        : TESTING_GUIDE_REGISTRY
    const configuredHarnesses = [...SURFACE_TARGETS, ...config.surfaces.harnesses.map(row => row.name)].sort()
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
    const mergedSources = merge.surfaces.flatMap(surface => surface.sources).map(source => ({
        path: source.path,
        bytes: source.path.startsWith('rules/') && !source.bytes.startsWith('---\n')
            ? `---\nroot: true\ntargets: ["*"]\n---\n${source.bytes}` : source.bytes,
    }))
    const generatedNativeSources = nativeSources(mcp, projection.grants, prepared.registry.secretPaths)
    const generatedSources = [...mergedSources, ...generatedNativeSources]
        .sort((left, right) => compareCodeUnits(left.path, right.path))
    if (new Set(generatedSources.map(source => source.path)).size !== generatedSources.length) {
        return refuse('SURFACE_PATH_CONFLICT', 'surface source paths collide with generated native sources', 'surfaces')
    }
    const features = SURFACE_FEATURES.filter(feature => generatedSources.some(source => source.path === `${feature}.jsonc`
        || source.path.startsWith(`${feature}/`) || feature === 'rules' && source.path.startsWith('rules/')
        || feature === 'subagents' && source.path.startsWith('subagents/') || feature === 'skills' && source.path.startsWith('skills/')))
    const bundleEntries: SurfaceDesiredEntry[] = []
    const expected = expectedSurfaceOutputs(features, generatedSources)
    const bundleRequest = config.surfaces.bundles.includes('claudecode-plugin') ? (() => {
        const bundleFeatures = features.filter(feature => feature === 'mcp' || feature === 'subagents'
            || feature === 'skills' || feature === 'hooks')
        const bundleSources = generatedSources.filter(source => source.path === 'mcp.jsonc' || source.path === 'hooks.jsonc'
            || source.path.startsWith('subagents/') || source.path.startsWith('skills/'))
        return Object.freeze({
            format: 'claudecode-plugin' as const,
            features: bundleFeatures,
            sources: bundleSources,
            expectedOutputs: expectedClaudePluginOutputs(bundleFeatures, bundleSources),
        })
    })() : undefined
    const estate = generatedSources.length === 0 ? undefined : await generateSurfaceEstate({
        batch: { targets: SURFACE_TARGETS, features, sources: generatedSources, expectedOutputs: expected },
        ...(bundleRequest ? { bundle: bundleRequest } : {}),
    })
    if (estate && estate.kind !== 'complete') return refuse('SURFACE_GENERATION_FAILED', estate.diagnostics[0]?.stderr
        ?? estate.diagnostics[0]?.message ?? 'built-in surface generation was refused', estate.diagnostics[0]?.target)
    const generated = estate?.kind === 'complete' && estate.batch ? estate.batch : emptyGeneration()

    if (config.surfaces.bundles.includes('claudecode-plugin')) {
        const bundle = estate?.kind === 'complete' ? estate.bundle : undefined
        if (!bundle) return refuse('SURFACE_GENERATION_FAILED', 'Claude plugin bundle generation was refused', 'claudecode-plugin')
        const manifest = claudePluginManifest()
        const files = [
            { path: '.claude-plugin/plugin.json', ...manifest },
            ...bundle.files,
        ]
        for (const file of files) bundleEntries.push(Object.freeze({
            kind: 'file' as const,
            ownership: 'whole-file' as const,
            path: `.cockpit/bundles/claudecode-plugin/${file.path}`,
            bytes: file.bytes,
            sha256: file.sha256,
            harnesses: Object.freeze(['claudecode']) as readonly ['claudecode'],
            scope: 'always' as const,
            capability: 'instructed' as const,
            writer: 'cockpit' as const,
            schemaVersion: 1 as const,
        }))
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
        collection: skillAsset('skills/collection.json'), terminal: skillAsset('skills/procedures/onboarding.md'), generated })
    if (skillInspection.kind !== 'complete') {
        const diagnostic = skillInspection.diagnostics[0]
        return refuse(diagnostic?.code ?? 'SKILL_RENDER_INVALID', diagnostic?.message ?? 'rendered skill set was refused', diagnostic?.target)
    }

    let modulePath: string
    try { modulePath = await realpath(fileURLToPath(new URL('../../dist/cli.js', import.meta.url))) }
    catch { return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', 'the installed guard handler is unavailable', 'guard') }
    const moduleRead = await readAnchoredFile(dirname(modulePath), basename(modulePath), MAX_GENERATED_BYTES, prepared.node, adapters)
    if (moduleRead.kind !== 'complete') return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', 'the installed guard handler is unavailable', 'guard')
    const rootStat = await lstat(prepared.root)
    const configStat = await lstat(prepared.configPath)
    // Only a fingerprint this process hashed to the authenticated digest may stand in for a re-hash.
    const nodeFingerprint = fileFingerprint(prepared.node.canonicalPath, await lstat(prepared.node.canonicalPath))
    if (verifiedDigest(nodeFingerprint) !== prepared.node.sha256) return refuse('GENERATED_EXECUTABLE_UNAVAILABLE',
        'the Node executable changed while sync was running', 'guard', 'run `cockpit sync` again in a terminal')
    const guardHandler: GuardHandlerIdentity = Object.freeze({ root: prepared.root,
        rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino),
        configPath: prepared.configPath, configSha256: prepared.sourceSha256,
        configDevice: String(configStat.dev), configInode: String(configStat.ino),
        node: prepared.node.canonicalPath, nodeSha256: prepared.node.sha256, nodeFingerprint,
        module: modulePath, moduleSha256: moduleRead.sha256 })
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
    const nativeGrants = nativeGrantFragmentSet(generated, projection.grants, nativeGrantPaths(grantTargets))
    const nativeMcp = generatedNativeMcp && nativeGrants ? bindNativeGrantsToMcp(generatedNativeMcp, nativeGrants) : undefined
    if (!nativeMcp || !nativeGrants) return refuse('SURFACE_INPUT_INVALID', 'native surface fragments could not be bound', 'surfaces')
    const runnerAsset = asset('scripts/browser-runner.sh')
    const browserSkillRendered = browser?.files.some(file => file.path.endsWith('/skills/cockpit-browser/SKILL.md')) === true
    const instructions = renderConsumerInstructions({
        name: config.cockpit.name,
        configFile: relative(prepared.root, prepared.configPath),
        siblings: config.sibling.map(row => ({ dir: row.dir, purpose: row.purpose, acquire: row.acquire })),
        hasStack: config.environment.generated !== undefined || config.environment.compose_files.length > 0,
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
    projectionInput.standingSources = GUARD_SURFACE_TARGETS.map(target => ({
        target,
        path: 'AGENTS.md',
        content: commonRootInstructions,
        scope: 'always' as const,
    }))
    projection = planSiblingProjection(projectionInput)
    if (projection.kind !== 'complete') return refuse(projection.diagnostic.code, projection.diagnostic.message, projection.diagnostic.target)
    const tierGuide = renderTierGuide(testingRegistry, projectionInput)
    if (tierGuide.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', tierGuide.reason, 'testing-tiers')
    if (!prepared.workEnvironment.testing && tierGuide.bytes !== asset('references/testing-tiers.md').bytes) {
        return refuse('SURFACE_INPUT_INVALID', 'the shipped testing tier guide differs from its canonical registry projection', 'references/testing-tiers.md')
    }
    const rendered = renderSurfaceSet({ configuredHarnesses, merge, generated, projection, mcp, restrictions, instructions,
        nativeMcp, nativeGrants, browser, browserReference: browser ? asset('references/browser.md').bytes : null,
        skillReferences: REFERENCE_ASSETS.map(path => ({ skill: SHIPPED_SETUP_SKILL, path, bytes: asset(path).bytes })),
        browserRunner: browser && prepared.workEnvironment.browser && Object.hasOwn(prepared.workEnvironment.browser, 'endpoint')
            ? { path: runnerAsset.path, bytes: runnerAsset.bytes, sha256: runnerAsset.sha256 } : null,
        testing: Object.freeze({ tierGuide, nativeHooks }),
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
    for (const entry of adoptedEntries) if (entry.kind === 'symlink') {
        const offset = relative(entry.source.root, entry.source.path)
        const destinationTarget = resolve(prepared.root, dirname(entry.path), entry.target)
        if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset) || destinationTarget !== entry.source.path
            || !evidence.some(row => row.kind === 'guide' && row.root === entry.source.root && row.path === entry.source.path
                && row.sha256 === entry.source.sha256 && row.identity === entry.source.identity)) {
            return refuse('SURFACE_STATE_CONFLICT', 'a projected symlink target is not bound to its authenticated sibling source', entry.path)
        }
    }
    const bound = bindSurfaceOwnershipIdentity(adoptedEntries, prepared.cockpitId)
    if (bound.kind !== 'complete') return refuse(bound.diagnostic.code, bound.diagnostic.message, bound.diagnostic.target)
    const surfaceEntries = Object.freeze([...bound.entries, ...bundleEntries]
        .sort((left, right) => compareCodeUnits(left.path, right.path)))
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
            browserSkillFiles.push(Object.freeze({ target: rendered.target, path: entry.path, bytes, sha256: entry.sha256 }))
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
    let missingLinkedGuide = false
    const rootGuideLines = guideLines(rootGuide.region.bytes)
    const actualGuideCosts = characterizedGuideCosts.map(cost => {
        const linkedGuideLines = cost.target === 'codexcli' ? 0 : projection.native
            .filter(native => native.target === cost.target)
            .reduce((sum, native) => {
                const link = projection.links.find(candidate => candidate.path === native.linkPath)
                const observation = link && observedGuides.observations.find(candidate => candidate.sourcePath === link.sourceGuidePath)
                if (!observation) {
                    missingLinkedGuide = true
                    return sum
                }
                return sum + guideLines(observation.content)
            }, 0)
        const value = rootGuideLines + linkedGuideLines
        return Object.freeze({ ...cost, value, status: value > cost.cap ? 'exceeded' as const : 'within_cap' as const })
    })
    if (missingLinkedGuide) return refuse('SURFACE_INPUT_INVALID', 'a published linked guide lost its authenticated measurement', 'AGENTS.md')
    if (actualGuideCosts.some(cost => cost.status !== 'within_cap')) {
        return refuse('SURFACE_INPUT_INVALID', 'combined published instruction cost exceeds the existing guide cap', 'AGENTS.md')
    }
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
        configuredHarnesses: Object.freeze(configuredHarnesses),
        declarations: config.surfaces.harnesses,
        entries: surfaceEntries,
        custom: customSelftest.sort((left, right) => compareCodeUnits(`${left.harness}\0${left.feature}`, `${right.harness}\0${right.feature}`)),
    }
    const captured = snapshotGeneratedJson(selftestPayload) as unknown as Omit<GeneratedSurfaceSelftestProjection, 'manifestSha256'> | undefined
    if (!captured) return refuse('SURFACE_BOUNDS', 'authenticated selftest inputs exceed the captured bounds', 'surfaces')
    const payload = { schema: captured.schema, configuredHarnesses: selftestPayload.configuredHarnesses,
        declarations: captured.declarations, entries: surfaceEntries, custom: captured.custom }
    const surfaceSelftest = Object.freeze({ ...payload, manifestSha256: sha256(JSON.stringify(payload)) })
    const skillInventory = Object.freeze(surfaceEntries.filter((entry): entry is Extract<SurfaceDesiredEntry, { kind: 'file' }> =>
        entry.kind === 'file').flatMap(entry => entry.harnesses.flatMap(target => {
        if (!SURFACE_TARGETS.includes(target as SurfaceTarget)) return []
        const prefix = `${harnessFact(target as SurfaceTarget).outputs.skills}/`
        if (!entry.path.startsWith(prefix) || !/^[^/]+\/SKILL\.md$/.test(entry.path.slice(prefix.length))) return []
        return [Object.freeze({ target, path: entry.path, sha256: entry.sha256 })]
    })).sort((left, right) => compareCodeUnits(`${left.target}\0${left.path}`, `${right.target}\0${right.path}`)))
    const installedSkillTargets = new Set(skillInventory.map(({ target }) => target))
    const installedSkillCosts = installedSkillInspection.costs.filter(({ target }) => installedSkillTargets.has(target))
    if (installedSkillCosts.length !== installedSkillTargets.size) {
        return refuse('SURFACE_INPUT_INVALID', 'a published skill target has no admitted standing-cost measurement', 'surfaces')
    }
    const surfaceHealth: GeneratedSurfaceHealthEvidence = Object.freeze({
        observedAt: prepared.producedAt,
        grants: Object.freeze(projection.grants.map(grant => Object.freeze({ ...grant }))),
        nativeGrants,
        guideCosts: Object.freeze(actualGuideCosts),
        skillCosts: Object.freeze(installedSkillCosts),
        skillInventorySha256: sha256(JSON.stringify(skillInventory)),
        skillInventory,
        skills: installedSkillInspection.skills,
        skillCollectionSha256: skillInspection.collection.source.sha256,
    })
    const customSurfacePaths = new Set(customReceipts.flatMap(receipt => receipt.files.map(file => file.path)))
    const compactSurfacePaths = new Set(generated.files.map(file => file.path).filter(path => !customSurfacePaths.has(path)))
    const evaluator = asset(EVALUATOR_ASSET)
    const workApplication: WorkApplicationAuthorityRecord = Object.freeze({
        workEnvironment: prepared.workEnvironment,
        evaluator: Object.freeze({
            path: resolve(SURFACE_ROOT, evaluator.path),
            bytes: evaluator.bytes,
            sha256: evaluator.sha256,
            identity: evaluator.identity,
            restriction: 'instructed',
        }),
        installedSkills: Object.freeze(surfaceEntries.filter((entry): entry is Extract<SurfaceDesiredEntry, { kind: 'file' }> =>
            entry.kind === 'file' && /^(?:\.agents|\.claude|\.opencode)\/skills\/[^/]+\/SKILL\.md$/.test(entry.path))
            .map(({ path, sha256: digest }) => Object.freeze({ path, sha256: digest }))
            .sort((left, right) => compareCodeUnits(left.path, right.path))),
        ...(browserAuthority ? { browser: browserAuthority } : {}),
        testing: Object.freeze({ registry: testingRegistry }),
    })
    return Object.freeze({ ...prepared, guardHandler, surfaces: surfaceEntries, compactSurfacePaths, configuredHarnesses: Object.freeze(configuredHarnesses),
        activeSurfaceOverrides: merge.overrides, changedOverrideOriginals: merge.findings,
        surfaceSelftest,
        surfaceHealth,
        guideSources: Object.freeze({
            requests: Object.freeze(guideRequests),
            observations: Object.freeze(observedGuides.observations.map(row => Object.freeze({ ...row }))
                .sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath))),
            missing: Object.freeze([...observedGuides.missing].sort(compareCodeUnits)),
        }),
        sourceEvidence: Object.freeze(evidence), sourceRoots: Object.freeze(sourceRoots), customSources: Object.freeze(customSources),
        adoptedSources: adopted.sources,
        ...(explicitNativeHooks ? { nativeHookPolicySource: explicitNativeHooks.source } : {}),
        surfaceAssets: Object.freeze(assets.map(({ path, sha256: digest, identity }) => Object.freeze({ path, sha256: digest, identity }))),
        workApplication,
        warnings: Object.freeze([...rendered.warnings]) })
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
    if (rows.length === 0) return Object.freeze({ entries, sources: Object.freeze([]) })
    const merged = [...entries]
    const sources: AdoptedSourceIdentity[] = []
    for (const row of rows) {
        const read = await readAnchoredFile(prepared.root, row.source, MAX_SURFACE_FILE_BYTES, prepared.node, adapters)
        if (read.kind !== 'complete') return refuse('SURFACE_ADOPTION_REFUSED',
            `the adopted copy of ${row.path} is ${read.kind === 'missing' ? 'missing' : 'not a bounded regular file'}; restore ${row.source} or remove its [[surfaces.adopted]] row`, row.source)
        let bytes: string
        try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) } catch {
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
            ? Object.freeze({ ...current, bytes: result.bytes, sha256: sha256(result.bytes) })
            : Object.freeze({ kind: 'file', path: row.path, harnesses: [harness] as [string], scope: 'always', capability: 'instructed', writer: 'cockpit',
                schemaVersion: 1, ownership: 'whole-file', bytes: result.bytes, sha256: sha256(result.bytes) })
        if (index < 0) merged.push(entry)
        else merged[index] = entry
        sources.push(Object.freeze({ path: row.source, sha256: read.sha256, identity: read.identity }))
    }
    merged.sort((left, right) => compareCodeUnits(left.path, right.path))
    return Object.freeze({ entries: Object.freeze(merged), sources: Object.freeze(sources) })
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
            const reads = await readAnchoredBatches(root, evidence.map(row => Object.freeze({
                path: row.path, maxBytes: MAX_GENERATED_BYTES, action: 'read-file' as const,
            })), prepared.node, adapters, deadline)
            if (!reads || reads.kind !== 'complete' || reads.results.length !== evidence.length || reads.results.some((read, index) => read.kind !== 'complete'
                || read.sha256 !== evidence[index]!.sha256 || sourceIdentity(read.identity) !== evidence[index]!.identity)) return false
            if (deadline !== undefined && Date.now() >= deadline) return false
        }
        const reads = await readAnchoredBatches(prepared.root, [
            Object.freeze({ path: prepared.personaSource.path, maxBytes: MAX_GENERATED_BYTES, action: 'read-persona' as const }),
            ...prepared.customSources.map(source => Object.freeze({ path: source.path, maxBytes: source.maxBytes, action: 'read-file' as const })),
            ...(prepared.nativeHookPolicySource ? [Object.freeze({ path: prepared.nativeHookPolicySource.path,
                maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const })] : []),
            ...prepared.adoptedSources.map(source => Object.freeze({ path: source.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const })),
        ], prepared.node, adapters, deadline)
        const adoptedOffset = prepared.customSources.length + 1 + (prepared.nativeHookPolicySource ? 1 : 0)
        if ((deadline !== undefined && Date.now() >= deadline) || !reads || reads.kind !== 'complete'
            || reads.results.length !== adoptedOffset + prepared.adoptedSources.length) return false
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
        if (!localCurrent) return false
        const assetReads = prepared.surfaceAssets.length === 0
            ? Object.freeze({ kind: 'complete' as const, results: Object.freeze([]) })
            : await readAnchoredBatches(SURFACE_ROOT, prepared.surfaceAssets.map(asset => Object.freeze({
            path: asset.path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
        })), prepared.node, adapters, deadline)
        if (!assetReads || assetReads.kind !== 'complete' || assetReads.results.length !== prepared.surfaceAssets.length || assetReads.results.some((read, index) => read.kind !== 'complete'
            || read.sha256 !== prepared.surfaceAssets[index]!.sha256
            || sourceIdentity(read.identity) !== sourceIdentity(prepared.surfaceAssets[index]!.identity))) return false
        if (deadline !== undefined && Date.now() >= deadline) return false
        return true
    } catch { return false }
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
        return Object.freeze({ kind: 'invalid' })
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
    let outcome: Readonly<{ kind: 'complete'; path?: string }> | Readonly<{ kind: 'invalid' }> = Object.freeze({ kind: 'invalid' })
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
                if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path !== prepared.root) continue
                throw error
            }
            handles.push(handle)
            const opened = await handle.stat({ bigint: true })
            const named = await lstat(path, { bigint: true })
            if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
                || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error('directory identity changed')
            if (path === prepared.root && (opened.dev !== BigInt(prepared.personaSourceIdentity.root.dev)
                || opened.ino !== BigInt(prepared.personaSourceIdentity.root.ino))) throw new Error('publication root identity changed')
            watches.push(Object.freeze({ path, handle, dev: opened.dev, ino: opened.ino,
                mtimeNs: opened.mtimeNs, ctimeNs: opened.ctimeNs }))
        }
        if (!(await Promise.all(watches.map(stable))).every(Boolean)) throw new Error('directory namespace changed')
        const exact = new Set<string>()
        const physical: Array<Readonly<{ dev: number; ino: number }>> = []
        for (const path of [...new Set(inputPaths)].sort(compareCodeUnits)) {
            const input = publicationInputPath(prepared.root, path)
            if (input) exact.add(input)
            let status: Awaited<ReturnType<typeof lstat>>
            try {
                status = await lstat(path)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT'
                    && missingGuidePaths.has(path) && !requiredPresentPaths.has(path)) continue
                throw error
            }
            physical.push(Object.freeze({ dev: status.dev, ino: status.ino }))
        }
        for (const row of [...prior].sort((left, right) => compareCodeUnits(left.path, right.path))) {
            if (exact.has(row.path)) {
                outcome = Object.freeze({ kind: 'complete', path: row.path })
                break
            }
            const path = resolve(prepared.root, row.path)
            let status: Awaited<ReturnType<typeof lstat>>
            try {
                status = await lstat(path)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
                throw error
            }
            if (physical.some(input => input.dev === status.dev && input.ino === status.ino)) {
                outcome = Object.freeze({ kind: 'complete', path: row.path })
                break
            }
        }
        if (outcome.kind === 'invalid') outcome = Object.freeze({ kind: 'complete' })
        if (!(await Promise.all(watches.map(stable))).every(Boolean)) outcome = Object.freeze({ kind: 'invalid' })
    } catch {
        outcome = Object.freeze({ kind: 'invalid' })
    } finally {
        for (const handle of handles.reverse()) try { await handle.close() } catch { closeFailed = true }
    }
    return closeFailed ? Object.freeze({ kind: 'invalid' }) : outcome
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
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 1 : undefined
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
    const entries = await readAnchoredBatches(prepared.root, orderedPaths.map((path, index) => Object.freeze({
        path, maxBytes: maxBytes[index]!, action: 'read-entry' as const,
    })), prepared.node, adapters)
    if (!entries || entries.kind !== 'complete' || entries.results.length !== orderedPaths.length) return undefined
    for (const [index, path] of orderedPaths.entries()) {
        const entry = entries.results[index]!
        if (entry.kind === 'invalid') return undefined
        if (entry.kind === 'complete') return undefined
        raw.set(path, entry)
        if (entry.kind === 'missing') observed.push(Object.freeze({ path, kind: 'missing' }))
        else if (entry.kind === 'file') {
            let bytes: string
            try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes) } catch {
                opaque.add(path)
                continue
            }
            observed.push(Object.freeze({ path, kind: 'file', bytes, sha256: entry.sha256, identity: sourceIdentity(entry.identity) }))
        } else if (entry.kind === 'symlink') observed.push(Object.freeze({ path, kind: 'symlink', target: entry.target, identity: JSON.stringify(entry.identity) }))
        else observed.push(Object.freeze({ path, kind: 'other', identity: 'other' }))
    }
    return Object.freeze({ observed: Object.freeze(observed), raw, opaque })
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
        else if (observed.kind === 'symlink' && fact.entry.kind === 'symlink') {
            const entry = fact.entry
            const source = await observeSiblingGuides({ allowedRoots: [entry.source.root], requests: [{ slug: 'owned', root: entry.source.root, sourcePath: entry.source.path }] })
            const guide = source.kind === 'complete' ? source.observations[0] : undefined
            observations.push({ path, kind: 'symlink', target: observed.target, identity: JSON.stringify(observed.identity),
                confinement: guide ? 'confined' : 'unknown',
                ...(guide ? { source: { ...entry.source, sha256: guide.contentSha256, identity: guide.contentIdentity } } : {}) })
        } else observations.push({ path, kind: observed.kind, confinement: observed.kind === 'missing' ? 'confined' : 'unknown' })
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
    return Object.freeze({ kind: 'complete', actions: Object.freeze(actions) })
}

/** A hand edit to a merged adopted file belongs in its adopted copy; say so where the conflict is reported. */
function surfacePlanRefusal(prepared: PreparedEnvironment, diagnostic: Readonly<{ code: string; message: string; target?: string }>): RefusalOutcome {
    const adopted = diagnostic.code === 'SURFACE_STATE_CONFLICT'
        ? prepared.registry.config.surfaces.adopted.find(row => row.path === diagnostic.target) : undefined
    return refuse(diagnostic.code, adopted
        ? `${diagnostic.message}; ${adopted.path} is merged from ${adopted.source}: make the change there, delete ${adopted.path}, and run cockpit sync --config <file>`
        : diagnostic.message, diagnostic.target)
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
        const current = raw.get(action.path) ?? Object.freeze({ kind: 'missing' as const })
        const expected = expectedState(current)
        if (!expected) return undefined
        if (action.kind === 'write') {
            const compactAnchor = compactSurfacePaths.has(action.path) ? compactAnchorFor(action.path) : undefined
            if (action.desired.kind === 'symlink') result.push(Object.freeze({ path: action.path, phase: 'desired', operation: 'write-symlink', target: action.desired.target, expected,
                ...(compactAnchor ? { compactAnchor } : {}) }))
            else {
                const bytes = action.desired.kind === 'file' ? action.desired.bytes : action.postimage
                if (bytes === undefined) return undefined
                result.push(Object.freeze({ path: action.path, phase: 'desired', operation: 'write-file', bytes, sha256: sha256(bytes), expected,
                    ...(compactAnchor ? { compactAnchor } : {}) }))
            }
        } else if (action.postimage !== undefined) result.push(Object.freeze({ path: action.path, phase: 'stale', operation: 'write-file', bytes: action.postimage,
            sha256: sha256(action.postimage), expected }))
        else result.push(Object.freeze({ path: action.path, phase: 'stale', operation: action.priorOwned.kind === 'symlink' ? 'remove-symlink' : 'remove-file', expected }))
    }
    return Object.freeze(result)
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
    const entries = await readAnchoredBatches(prepared.root, paths.map(path => Object.freeze({
        path, maxBytes: MAX_GENERATED_BYTES, action: 'read-entry' as const,
    })), prepared.node, adapters)
    if (!entries) return Object.freeze({ kind: 'invalid', path: paths[0] ?? 'generated-environment' })
    if (entries.kind === 'invalid') return Object.freeze({ kind: 'invalid', path: paths[entries.index] ?? paths[0] ?? 'generated-environment' })
    if (entries.results.length !== paths.length) return Object.freeze({ kind: 'invalid', path: paths[0] ?? 'generated-environment' })
    const classified = await classifyOwnedState(prepared, manifest, new Map(paths.map((path, index) => [path, entries.results[index]!])))
    if (classified.kind !== 'complete') return Object.freeze({ kind: 'invalid', path: classified.diagnostic.target ?? 'generated-environment' })
    const unknown = classified.paths.find(row => row.state === 'unknown')
    if (unknown) return Object.freeze({ kind: 'invalid', path: unknown.fact.path })
    for (const [index, path] of paths.entries()) {
        const current = entries.results[index]!
        if (current.kind === 'complete') return Object.freeze({ kind: 'invalid', path })
        const expected = expectedState(current)
        if (!expected) return Object.freeze({ kind: 'invalid', path })
        const owned = priorEnvironment.get(path)
        const next = desired.get(path)
        if (current.kind !== 'missing' && (!owned || current.kind !== 'file'
            || current.sha256 !== owned.sha256 && next?.sha256 !== owned.sha256)) {
            return Object.freeze({ kind: 'invalid', path })
        }
        if (next) {
            if (current.kind === 'file' && current.sha256 === next.sha256) continue
            mutations.push(Object.freeze({ path, phase: 'desired', operation: 'write-file', bytes: next.bytes, sha256: next.sha256, expected }))
        } else if (current.kind === 'file') mutations.push(Object.freeze({ path, phase: 'stale', operation: 'remove-file', expected }))
    }
    return Object.freeze({ kind: 'complete', mutations: Object.freeze(mutations) })
}

async function preparePublication(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
    seed?: PreparedEnvironment,
    knownOwnership?: OwnershipState,
    portLease?: PortLeaseProjection,
): Promise<RefusalOutcome | Readonly<{
    prepared: PreparedEnvironment; ownership: OwnershipState; plan: PublicationPlan
}> | Readonly<{
    prepared: PreparedEnvironment; ownership: OwnershipState; refusal: RefusalOutcome
}>> {
    const request = syncCommandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const adapters = mergedAdapters(adapterOverrides)
    const base = seed ?? await prepare({ configPath: request.configPath }, adapters, portLease)
    if ('status' in base) return base
    const ownership = knownOwnership ?? await readOwnership(base, adapters)
    if (ownership.kind === 'unsupported') return refuse(
        'GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED', `generated ownership format ${ownership.format} is not supported`, OWNERSHIP_PATH,
    )
    if (ownership.kind === 'invalid') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata is malformed or unsafe', OWNERSHIP_PATH,
        'restore the last trusted ownership metadata before syncing',
    )
    const adoptedBootstrap = ownership.kind === 'missing' && request.bootstrapState
        ? await authenticatedBootstrapPriorSurfaces(base.root, request.bootstrapState, base.node, adapters) : undefined
    if (ownership.kind === 'missing' && request.bootstrapState && !adoptedBootstrap) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'bootstrap state, packaged sources, or published outputs could not be authenticated', 'bootstrap',
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
    let prepared = await prepareSurfaces(base, priorSurfaces, adapters, ownership.kind === 'complete' ? ownership.manifest : undefined)
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
    if (environment.kind === 'invalid') return Object.freeze({ prepared, ownership, refusal: refuse(
        'GENERATED_STALE_ARTIFACT_DRIFT', 'a generated whole-file path is unmanaged, changed, or unsafe', environment.path,
    ) })
    const plan = planObservedSurfaces(prepared, effectivePriorSurfaces, surfaceState)
    if (plan.kind !== 'complete') return surfacePlanRefusal(prepared, plan.diagnostic)
    const surface = surfaceMutations(plan.actions, surfaceState.raw, prepared.compactSurfacePaths)
    if (!surface) return refuse('SURFACE_STATE_CONFLICT', 'surface change plan could not be admitted', 'surfaces')
    const all = [...environment.mutations, ...surface]
    if (new Set(all.map(row => row.path)).size !== all.length) return refuse('SURFACE_PATH_CONFLICT', 'generated output estates overlap', 'generated-environment')
    const previousProducer = ownership.kind === 'complete' ? ownership.manifest.producer : null
    const identityUnchanged = previousProducer?.package === installedPackageMetadata.name
        && previousProducer.version === installedPackageMetadata.version
        && previousProducer.sourceRevision === installedPackageMetadata.cockpitSourceRevision
    if (identityUnchanged && all.length === 0 && ownership.kind === 'complete') {
        const candidate = Object.freeze({ ...prepared, producedAt: previousProducer.producedAt })
        if (encodeOwnershipManifest(candidate).bytes === ownership.bytes) prepared = candidate
    }
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
        mutations: Object.freeze(all),
        surfaceActions: plan.actions,
    }, adapters)
    if (publication.kind === 'refusal') return Object.freeze({ prepared, ownership, refusal: publication })
    return Object.freeze({ prepared, ownership, plan: publication.plan })
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
    readonly decisions?: GeneratedDecisionReport
}

interface RepairRecord {
    readonly prepared: PreparedEnvironment
    readonly plan: PublicationPlan
    readonly adapters: GeneratedEnvironmentCommandAdapters
}
const issuedRepairs = new WeakMap<GeneratedEnvironmentRepairAuthority, RepairRecord>()

function issueRepairAuthority(record: RepairRecord): GeneratedEnvironmentRepairAuthority {
    const authority: GeneratedEnvironmentRepairAuthority = Object.freeze({ kind: 'generated-environment-repair' })
    issuedRepairs.set(authority, record)
    return authority
}

export async function prepareGeneratedEnvironmentCurrentness(
    input: GeneratedEnvironmentCommandInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
    portLease?: PortLeaseProjection,
): Promise<GeneratedEnvironmentCurrentness> {
    const adapters = mergedAdapters(adapterOverrides)
    const base = await prepare(input, adapters, portLease)
    const ownership = 'status' in base ? undefined : await readOwnership(base, adapters)
    const publication = 'status' in base ? base : await preparePublication(input, adapters, base, ownership)
    const prepared = 'prepared' in publication ? publication.prepared : undefined
    const outcome = 'status' in publication ? publication : await checkCanonicalGeneratedEnvironment(input, prepared, adapters)
    const authority = prepared && 'plan' in publication
        ? issueRepairAuthority({ prepared, plan: publication.plan, adapters }) : undefined
    const decisions = prepared?.rendered && undecidedGeneratedDecisions(prepared.rendered)
    return Object.freeze({
        outcome,
        changes: 'plan' in publication ? publication.plan.changes : Object.freeze([]),
        storedProducer: ownership?.kind === 'complete' ? ownership.manifest.producer : null,
        currentProducer: Object.freeze({ package: installedPackageMetadata.name, version: installedPackageMetadata.version,
            sourceRevision: installedPackageMetadata.cockpitSourceRevision }),
        fixContext: Object.freeze({ resolvedConfigPath: prepared?.configPath ?? null,
            generatedTargets: Object.freeze(prepared ? [...prepared.owned, ...prepared.surfaces].map(row => row.path) : []) }),
        ...(authority ? { repairAuthority: authority } : {}),
        ...(decisions ? { decisions } : {}),
        ...('status' in publication ? { repairRefusal: publication }
            : 'refusal' in publication ? { repairRefusal: publication.refusal } : {}),
    })
}

async function prepareGeneratedEnvironmentSync(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters>,
    portLease?: PortLeaseProjection,
    metadataChanges: readonly TeamMetadataChange[] = [],
): Promise<RefusalOutcome | Readonly<{ kind: 'complete'; authority: GeneratedEnvironmentRepairAuthority; dryRun: boolean }>> {
    const request = syncCommandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const adapters = mergedAdapters(adapterOverrides)
    const publication = await preparePublication(request, adapters, undefined, undefined, portLease)
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
            'a pending team metadata write overlaps a generated destination; move the generated output to a separate path, then run cockpit sync again', destination.path)
        const overlap = await ownedInputOverlap(publication.prepared, metadataChanges)
        if (overlap.kind === 'invalid' || overlap.path) return refuse('TEAM_METADATA_UNAVAILABLE',
            'pending team metadata writes overlap an authenticated input or its identity could not be checked; move the input to a separate file, update its declaration, then run cockpit sync again',
            overlap.kind === 'complete' ? overlap.path : 'team-metadata')
    }
    const authority = issueRepairAuthority({ prepared: publication.prepared, plan: publication.plan, adapters })
    return { kind: 'complete', authority, dryRun: request.dryRun === true }
}

export async function syncGeneratedEnvironment(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
    portLease?: PortLeaseProjection,
): Promise<GeneratedEnvironmentCommandOutcome> {
    const prepared = await prepareGeneratedEnvironmentSync(input, adapterOverrides, portLease)
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
    const prepared = await prepareGeneratedEnvironmentSync(request, adapterOverrides, undefined, metadata.authority.changes)
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
        result: { ...outcome.result, changes: Object.freeze([...metadata.authority.changes, ...outcome.result.changes]) } }
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
            GUARD_LOCAL_PATHS.identity, 'fix the path, then run `cockpit sync` again in a terminal')
    }
    return complete('sync', prepared, settings.dryRun === true, outcome.changes, settings.dryRun ? outcome.staleRemoval : undefined)
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
        'restore trusted ownership metadata or run cockpit sync --config <file>',
    )
    const priorSurfaces = ownership.manifest.entries.filter((row): row is SurfacePriorOwnedEntry => 'harnesses' in row)
    const prepared = seed?.surfaceSelftest ? seed : await prepareSurfaces(base, priorSurfaces, adapters, ownership.manifest)
    if ('status' in prepared) return prepared
    const ownedInput = await ownedInputOverlap(prepared, ownership.manifest.entries)
    if (ownedInput.kind === 'invalid') return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'authenticated input identity could not be compared with generated ownership metadata', OWNERSHIP_PATH,
        'restore trusted ownership metadata or run cockpit sync --config <file>',
    )
    if (ownedInput.path) return refuse(
        'GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata overlaps an authenticated input', ownedInput.path,
        'restore trusted ownership metadata or run cockpit sync --config <file>',
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
        'run cockpit sync --config <file>')
    const generatedCandidates: Array<{ path: string; bytes: string }> = []
    const required = generatedPathFacts(prepared, 'required-after-sync')
    if (required.kind !== 'complete') return refuse(required.diagnostic.code, required.diagnostic.message, required.diagnostic.target)
    const canonicalReads = await readAnchoredBatches(prepared.root, [...prepared.generated, ...prepared.persona].map(file => Object.freeze({
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
            if (!read || read.kind !== 'complete') throw new Error('generated artifact unavailable')
            const fact = required.facts.find(fact => fact.path === file.path)!
            const classification = classifyGeneratedPaths([fact], [{ path: file.path, kind: 'file', bytes: read.bytes,
                confinement: 'confined', identity: sourceIdentity(read.identity) }])
            if (classification.kind !== 'complete' || classification.paths[0]?.state === 'unknown') return refuse(
                'GENERATED_ARTIFACT_MISSING', 'owned generated artifact could not be classified safely', file.path, 'run cockpit sync --config <file>',
            )
            generatedCandidates.push({ path: file.path, bytes: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) })
        } catch {
            return refuse('GENERATED_ARTIFACT_MISSING', 'owned generated artifact became unreadable', file.path, 'run cockpit sync --config <file>')
        }
    }
    const inspected = prepared.rendered
        && inspectGeneratedEnvironment({ rendered: prepared.rendered, candidates: generatedCandidates, now: prepared.now })
    if (inspected && inspected.kind !== 'passed') return refuse(inspected.code, inspected.reason, inspected.target, 'run cockpit sync --config <file>')
    for (const [personaIndex, file] of prepared.persona.entries()) {
        const index = prepared.generated.length + personaIndex
        const read = canonicalReads?.kind === 'complete' ? canonicalReads.results[index]
            : canonicalReads?.kind === 'invalid' && index < canonicalReads.index
                ? await readAnchoredFile(prepared.root, file.path, MAX_GENERATED_BYTES, prepared.node, adapters)
                : undefined
        if (!read || read.kind !== 'complete') {
            return refuse('GENERATED_ARTIFACT_MISSING', 'owned persona artifact became unreadable', file.path, 'run cockpit sync --config <file>')
        }
        const fact = required.facts.find(fact => fact.path === file.path)!
        const classification = classifyGeneratedPaths([fact], [{ path: file.path, kind: 'file', bytes: read.bytes,
            confinement: 'confined', identity: sourceIdentity(read.identity) }])
        if (classification.kind !== 'complete' || classification.paths[0]?.state !== 'unchanged') {
            return refuse('GENERATED_ARTIFACT_DRIFT', 'owned persona artifact differs from canonical bytes', file.path, 'run cockpit sync --config <file>')
        }
    }
    const comparison = planObservedSurfaces(prepared, effectivePriorSurfaces, surfaceState)
    if (comparison.kind !== 'complete') return surfacePlanRefusal(prepared, comparison.diagnostic)
    const drift = comparison.actions.map(action => action.path)
    if (drift.length > 0) return refuse('GENERATED_ARTIFACT_DRIFT', 'owned surface state differs from the canonical model', drift[0]!, 'run cockpit sync --config <file>')
    if (ownership.bytes !== encodeOwnershipManifest(prepared).bytes) return refuse(
        'GENERATED_OWNERSHIP_DRIFT', 'generated ownership metadata differs from the current canonical manifest', OWNERSHIP_PATH,
        'run cockpit sync --config <file>',
    )
    const source = await observeConfigSource(prepared.configPath)
    if (source.state !== 'available' || source.sha256 !== prepared.sourceSha256
        || !await inputSourcesCurrent(prepared, adapters)) {
        return refuse('GENERATED_SOURCE_CHANGED', 'a generated input changed during generated environment checking', 'generated-environment')
    }
    return complete('check', prepared)
}

// A cockpit running its own Compose files owns that topology, so check reads it as Compose resolves
// it and reports what would break parallel stacks; a generated stack was rendered to avoid all of it.
async function composeTopologyDiagnostics(
    configPath: string,
    sourceSha256: string,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<readonly Diagnostic[]> {
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete' || loaded.result.source.sha256 !== sourceSha256) return Object.freeze([{ severity: 'error' as const,
        code: 'GENERATED_SOURCE_CHANGED', message: 'the configuration changed while check was reading the Compose topology', target: configPath }])
    const config = loaded.result.config
    if (declaredRuntime(config.environment) !== 'compose') return Object.freeze([])
    const env = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
        DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY, DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH }
    const [docker, node] = await Promise.all([resolveDockerExecutable(process.env), nodeAuthority()])
    const observed = docker.state !== 'available' ? Object.freeze({ kind: 'unavailable' as const, reason: docker.reason })
        : !node ? Object.freeze({ kind: 'unavailable' as const, reason: 'the current Node executable could not be authenticated' })
            : await observeComposeTopology({ root: dirname(loaded.result.source.path), references: config.environment.compose_files,
                projectName: config.cockpit.name, docker: docker.value, node, env }, adapters.execute)
    if (observed.kind !== 'complete') return Object.freeze([{ severity: 'error' as const, code: 'COMPOSE_TOPOLOGY_UNAVAILABLE',
        message: `check could not read the declared Compose topology, so its ports, healthchecks and images are unverified: ${observed.reason}`,
        target: config.environment.compose_files.join(', '),
        fix: 'install Docker with the Compose plugin on PATH and make `docker compose config` succeed for environment.compose_files' }])
    return assessComposeTopology(observed.services, Object.keys(config.ports.bases))
}

export async function checkGeneratedEnvironment(
    input: GeneratedEnvironmentCommandInput,
    portLease?: PortLeaseProjection,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<GeneratedEnvironmentCommandOutcome> {
    const adapters = mergedAdapters(adapterOverrides)
    const currentness = await prepareGeneratedEnvironmentCurrentness(input, adapters, portLease)
    const undecided = currentness.decisions
    const topology = currentness.outcome.kind === 'complete'
        ? await composeTopologyDiagnostics(input.configPath, currentness.outcome.result.sourceSha256, adapters) : []
    const diagnostics = currentness.outcome.kind === 'complete' && undecided && undecided.undecided > 0
        ? Object.freeze([...currentness.outcome.diagnostics, {
            severity: 'info' as const, code: 'GENERATED_DECISIONS_UNDECIDED', target: undecided.path,
            message: `${undecided.undecided} structural subject${undecided.undecided === 1 ? ' has' : 's have'} no decision entry and ${undecided.undecided === 1 ? 'is' : 'are'} listed as undecided: ${undecided.subjects.join(', ')}; record each under environment.generated.decisions.entries when it is decided`,
        }])
        : Object.freeze([...currentness.outcome.diagnostics, ...topology])
    const outcome = topology.some(row => row.severity === 'error')
        ? Object.freeze({ kind: 'refusal' as const, artifact: null, destination: null, result: null, status: 2 as const, diagnostics })
        : Object.freeze({ ...currentness.outcome, diagnostics })
    return Object.freeze({ ...outcome, fixContext: currentness.fixContext, report: Object.freeze({
        storedProducer: currentness.storedProducer, currentProducer: currentness.currentProducer,
        repair: proposeGeneratedEnvironmentRepair(currentness),
        ...(undecided ? { decisions: undecided } : {}),
    }) })
}
