import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

import { loadCockpitConfig, observeConfigSource } from '../config/load.js'
import type { Diagnostic } from '../diagnostics.js'
import { executeProbe } from '../environment-exec/execute.js'
import { readActiveStackInventory } from '../environment/claims.js'
import { ENVIRONMENT_CODES, snapshotGeneratedJson, type HolderId } from '../environment/contract.js'
import { checkoutId, cockpitId, stackId } from '../environment/identity.js'
import { abortStateTransaction, snapshotStateNamespace, transactState, type StateNamespace } from '../environment/state.js'
import { classifyGeneratedPaths, parseOwnershipManifest, projectGeneratedPathFacts, removeSharedOwnership, type OwnershipManifest } from '../surfaces/ownership.js'
import { observeSiblingGuides } from '../surfaces/projection.js'
import { admitPublicationPlan, expectedState, nodeAuthority, readAnchoredBatches, readAnchoredFile, runPublicationPlan,
    type PublicationAdapters, type PublicationMutation, type PublicationOutcome, type PublicationRefusal } from './transaction.js'

export const mechanism = {
    id: 'generated-removal-application',
    module: 'packages/cockpit/src/generated-environment/uninstall.ts',
    exports: ['forgetGeneratedEnvironment', 'uninstallGeneratedEnvironment'],
} as const

export interface GeneratedRemovalInput {
    readonly configPath: string
    readonly dryRun?: boolean
}

export interface GeneratedRemovalContext {
    readonly namespace: StateNamespace
    readonly ownerId: HolderId
}

export interface GeneratedRemovalAdapters extends PublicationAdapters {
    readonly observeSource: typeof observeConfigSource
}

const OWNERSHIP_PATH = '.cockpit/generated-environment-ownership.json'
const MAX_OWNERSHIP_BYTES = 1_048_576
const MAX_GENERATED_BYTES = 16_777_216

function refuse(code: string, message: string, target: string): PublicationRefusal {
    return Object.freeze({ kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: Object.freeze([Object.freeze({ severity: 'error' as const, code, message, target })]) })
}

function diagnosticsRefusal(diagnostics: readonly Diagnostic[]): PublicationRefusal {
    return Object.freeze({ kind: 'refusal', artifact: null, destination: null, result: null, status: 2, diagnostics: Object.freeze([...diagnostics]) })
}

async function siblingSourcesCurrent(root: string, manifest: OwnershipManifest): Promise<boolean> {
    for (const entry of manifest.entries) {
        if (entry.kind !== 'symlink') continue
        if (resolve(root, dirname(entry.path), entry.target) !== entry.source.path) return false
        const observed = await observeSiblingGuides({ allowedRoots: [entry.source.root], requests: [{ slug: 'owned', root: entry.source.root, sourcePath: entry.source.path }] })
        const guide = observed.kind === 'complete' ? observed.observations[0] : undefined
        if (!guide || guide.contentSha256 !== entry.source.sha256 || guide.contentIdentity !== entry.source.identity) return false
    }
    return true
}

async function remove(
    mode: 'forget' | 'uninstall',
    input: GeneratedRemovalInput,
    context: GeneratedRemovalContext,
    overrides: Partial<GeneratedRemovalAdapters>,
): Promise<PublicationOutcome> {
    const request = snapshotGeneratedJson(input) as unknown as GeneratedRemovalInput | undefined
    if (!request || typeof request.configPath !== 'string' || request.configPath.length === 0 || /[\x00-\x1f\x7f]/.test(request.configPath)
        || Object.keys(request).some(key => key !== 'configPath' && key !== 'dryRun')
        || request.dryRun !== undefined && typeof request.dryRun !== 'boolean') return refuse('GENERATED_INPUT_INVALID', 'generated removal input is invalid', 'generated-environment')
    const loaded = await loadCockpitConfig(request.configPath)
    if (loaded.kind !== 'complete') return diagnosticsRefusal(loaded.diagnostics)
    const root = dirname(loaded.result.source.path)
    const cockpit = cockpitId({ name: loaded.result.config.cockpit.name, mainCheckoutPath: root })
    const namespace = snapshotStateNamespace(context?.namespace)
    if (!namespace || namespace.cockpitRoot !== join(namespace.root, 'cockpits', cockpit)) return refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'removal requires the current cockpit coordination namespace', root)
    const stack = stackId({ cockpitId: cockpit, checkoutId: checkoutId({ checkoutPath: root }), variant: { kind: 'shared' } })
    const ownerId = context.ownerId
    const adapters = { execute: executeProbe, observeSource: observeConfigSource, ...overrides }
    // Hold the existing coordination lock through publication so a new claim cannot
    // arrive between an empty inventory and deletion of its generated environment.
    const locked = await transactState<PublicationOutcome>(namespace, namespace.paths.coordination(stack), { ownerId }, async () => {
        const inventory = async (): Promise<PublicationRefusal | undefined> => {
            const active = await readActiveStackInventory(namespace)
            if (active.kind !== 'complete') return diagnosticsRefusal(active.diagnostics)
            if (active.value.length === 0) return undefined
            const held = active.value.map(row => `${row.stackId} (${row.record.holders.map(holder => holder.holderId).join(', ') || 'retained port lease'})`).join('; ')
            return refuse('GENERATED_UNINSTALL_HELD', `generated ownership is held by ${held}; run cockpit down for each named stack before ${mode}`, root)
        }
        const held = await inventory()
        if (held) return abortStateTransaction(held)
        const node = await nodeAuthority()
        if (!node) return abortStateTransaction(refuse('GENERATED_EXECUTABLE_UNAVAILABLE', 'the current Node executable could not be authenticated', process.execPath))
        const ledger = await readAnchoredFile(root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, node, adapters)
        if (ledger.kind !== 'complete') return abortStateTransaction(refuse(ledger.kind === 'missing' ? 'GENERATED_OWNERSHIP_MISSING' : 'GENERATED_OWNERSHIP_INVALID', 'removal requires readable durable ownership metadata', OWNERSHIP_PATH))
        let manifest
        try { manifest = parseOwnershipManifest(new TextDecoder('utf-8', { fatal: true }).decode(ledger.bytes), { root, cockpitId: cockpit, configPath: loaded.result.source.path }) } catch {
            return abortStateTransaction(refuse('GENERATED_OWNERSHIP_INVALID', 'generated ownership bytes cannot be decoded', OWNERSHIP_PATH))
        }
        if (manifest.kind === 'unsupported') return abortStateTransaction(refuse('GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED', `generated ownership format ${manifest.format} is not supported`, OWNERSHIP_PATH))
        if (manifest.kind !== 'complete') return abortStateTransaction(refuse('GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata is malformed or unsafe', OWNERSHIP_PATH))
        const owned = manifest.manifest
        const authority = { root, cockpitId: cockpit, configPath: loaded.result.source.path }
        const mutations: PublicationMutation[] = []
        if (mode === 'uninstall') {
            if (!await siblingSourcesCurrent(root, owned)) return abortStateTransaction(refuse('GENERATED_STALE_ARTIFACT_DRIFT', 'owned sibling identity or confinement is unknown', 'surfaces'))
            const reads = await readAnchoredBatches(root, owned.entries.map(entry => ({ path: entry.path, action: 'read-entry', maxBytes: MAX_GENERATED_BYTES })), node, adapters)
            if (!reads || reads.kind !== 'complete' || reads.results.length !== owned.entries.length) return abortStateTransaction(refuse('GENERATED_STALE_ARTIFACT_DRIFT', 'owned leaves could not be observed safely', OWNERSHIP_PATH))
            const facts = projectGeneratedPathFacts(owned, authority, [])
            if (facts.kind !== 'complete') return abortStateTransaction(refuse(facts.diagnostic.code, facts.diagnostic.message, facts.diagnostic.target ?? OWNERSHIP_PATH))
            const classified = classifyGeneratedPaths(facts.facts, reads.results.map((read, index) => {
                const entry = owned.entries[index]!
                if (read.kind === 'file') return { path: entry.path, kind: 'file', bytes: read.bytes, identity: JSON.stringify(read.identity), confinement: 'confined' }
                if (read.kind === 'symlink' && entry.kind === 'symlink') return { path: entry.path, kind: 'symlink', target: read.target, identity: JSON.stringify(read.identity), source: entry.source, confinement: 'confined' }
                return { path: entry.path, kind: read.kind, confinement: read.kind === 'missing' ? 'confined' : 'unknown' }
            }))
            if (classified.kind !== 'complete') return abortStateTransaction(refuse(classified.diagnostic.code, classified.diagnostic.message, classified.diagnostic.target ?? OWNERSHIP_PATH))
            for (const [index, entry] of owned.entries.entries()) {
                const read = reads.results[index]!
                if (read.kind === 'missing') continue
                if (read.kind === 'complete' || classified.paths[index]?.state !== 'unchanged') return abortStateTransaction(refuse('GENERATED_STALE_ARTIFACT_DRIFT', 'uninstall requires exact unchanged manifest leaves', entry.path))
                const expected = expectedState(read)
                if (!expected) return abortStateTransaction(refuse('GENERATED_STALE_ARTIFACT_DRIFT', 'owned target identity is unknown', entry.path))
                if (entry.kind === 'shared-region' && read.kind === 'file') {
                    const postimage = removeSharedOwnership(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes), entry, owned)
                    if (postimage.kind !== 'complete') return abortStateTransaction(refuse(postimage.diagnostic.code, postimage.diagnostic.message, entry.path))
                    mutations.push({ path: entry.path, phase: 'stale', operation: 'write-file', expected, bytes: postimage.bytes, sha256: createHash('sha256').update(postimage.bytes).digest('hex') })
                } else mutations.push({ path: entry.path, phase: 'stale', operation: entry.kind === 'symlink' ? 'remove-symlink' : 'remove-file', expected })
            }
        }
        const publication = await admitPublicationPlan({ authority, generation: owned.generation, sourceSha256: loaded.result.source.sha256,
            rootIdentity: ledger.identity.root, node, mode, ledgerExpected: { kind: 'file', sha256: ledger.sha256, identity: ledger.identity.file }, nextLedgerBytes: null, mutations }, adapters)
        if (publication.kind === 'refusal') return abortStateTransaction(publication)
        const outcome = await runPublicationPlan(publication.plan, { ...adapters, dryRun: request.dryRun === true, revalidate: async deadline => {
            if (deadline !== undefined && Date.now() >= deadline || await inventory()) return false
            const current = await adapters.observeSource(loaded.result.source.path)
            return current.state === 'available' && current.sha256 === loaded.result.source.sha256
                && (mode === 'forget' || await siblingSourcesCurrent(root, owned))
        } })
        return abortStateTransaction(outcome)
    })
    if ('aborted' in locked) return locked.value
    return refuse(locked.kind === 'refusal' ? locked.code : ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
        locked.kind === 'refusal' ? `${locked.message}${locked.recovery ? `; ${locked.recovery}` : ''}` : 'generated removal coordination lock could not be safely released',
        locked.kind === 'refusal' ? locked.target : namespace.paths.stateLock)
}

export async function forgetGeneratedEnvironment(input: GeneratedRemovalInput, context: GeneratedRemovalContext, adapters: Partial<GeneratedRemovalAdapters> = {}): Promise<PublicationOutcome> {
    return remove('forget', input, context, adapters)
}

export async function uninstallGeneratedEnvironment(input: GeneratedRemovalInput, context: GeneratedRemovalContext, adapters: Partial<GeneratedRemovalAdapters> = {}): Promise<PublicationOutcome> {
    return remove('uninstall', input, context, adapters)
}
