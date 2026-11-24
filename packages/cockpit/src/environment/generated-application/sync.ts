import { prepareTeamMetadata, applyTeamMetadata, type TeamMetadataChange } from '../../team-metadata.js'
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUARD_LOCAL_PATHS, parseGuardLocalIdentity, writeCockpitLocalFiles, writeGuardLocalIdentity, type GuardHandlerIdentity } from '../../guards/local-identity.js'
import { linkedWorktreeMainCheckout } from '../../guards/linked-worktree.js'
import { ENVIRONMENT_CODES, errorCause, hasErrorCode } from '../contract.js'
import { readBoundedFile } from '../../bounded-read.js'
import { ADOPTABLE_SURFACE_PATHS } from '../../surfaces/contract.js'
import { parseOwnershipManifest } from '../../surfaces/ownership.js'
import { publicationCockpitId } from '../identity.js'
import { adoptedCopyPath } from '../../surfaces/adoption.js'
import { GUARD_HELD_CALLS } from '../../surfaces/harness-registry.js'
import { portablePublicationPaths, authorizePublicationPlan, runPublicationPlan } from '../../generated-environment/transaction.js'
import { refusalOutcome as refuse } from '../../refusal.js'
import { parseCockpitConfigBytes, readBoundedInput } from '../../config/load.js'
import { guardWideningUnconfirmedDiagnostic, observeGuardConfigChange } from '../../guards/policy-change.js'
import {
    type GeneratedEnvironmentCommandAdapters,
    type GeneratedEnvironmentCommandOutcome,
    type GeneratedEnvironmentRepairAuthority,
    type GeneratedEnvironmentSyncInput,
    type GuardWideningApproval,
    type PreparedEnvironment,
    type RefusalOutcome,
    OWNERSHIP_PATH,
    authenticateSiblingRoots,
    complete,
    mergedAdapters,
    overrideChangedRefusal,
    ownRecord,
    sha256,
} from './shared.js'
import { syncCommandInput } from './prepare.js'
import { inputSourcesCurrent, ownedInputOverlap, preparePublication } from './publication.js'
import { checkCanonicalGeneratedEnvironment, issueRepairAuthority, issuedRepairs } from './check.js'
import { openCodeGrantFile, staleMcpOutputsOnly } from './surface-outputs.js'
import { readSiblingCheckouts } from '../sibling-checkouts.js'
import { openCodeGrantDirectory, openCodePatternUnsafe, writeClaudeLocalGuard } from '../served-checkout-grants.js'
import { GUARD_SCRIPT_PATH, writeGuardRecord } from '../../guards/guard-record.js'

async function prepareGeneratedEnvironmentSync(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters>,
    metadataChanges: readonly TeamMetadataChange[] = [],
): Promise<RefusalOutcome | Readonly<{ kind: 'complete'; authority: GeneratedEnvironmentRepairAuthority; dryRun: boolean }>> {
    const request = syncCommandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    // A bind publishes nothing and checks its own authority; it never rides a publishing sync.
    if (request.bindWorktree) return refuse('GENERATED_INPUT_INVALID', 'a worktree bind runs only on its own, as cockpit sync --bind-worktree', 'generated-environment')
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
            'a pending team metadata write overlaps a generated destination; move the generated output to a separate path, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> again', destination.path)
        const overlap = await ownedInputOverlap(publication.prepared, metadataChanges)
        if (overlap.kind === 'invalid' || overlap.path) return refuse('TEAM_METADATA_UNAVAILABLE',
            'pending team metadata writes overlap an authenticated input or its identity could not be checked; move the input to a separate file, update its declaration, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> again',
            overlap.kind === 'complete' ? overlap.path : 'team-metadata')
    }
    // Restricting a server takes it out of a tool with no restriction mechanism. Waiting for a person
    // there would leave every other tool unrestricted too, so a reduction does not take that approval.
    const authorizeStaleRemoval: typeof adapters.authorizeStaleRemoval = async request =>
        staleMcpOutputsOnly(request.entries.map(entry => entry.path), publication.prepared.configuredHarnesses)
            ? { format: 'cockpit-stale-removal-approval/v1', digest: request.digest }
            : adapters.authorizeStaleRemoval?.(request)
    const authority = issueRepairAuthority({ prepared: publication.prepared, plan: publication.plan, adapters: { ...adapters, authorizeStaleRemoval } })
    return { kind: 'complete', authority, dryRun: request.dryRun === true }
}

export async function syncGeneratedEnvironment(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<GeneratedEnvironmentCommandOutcome> {
    const prepared = await prepareGeneratedEnvironmentSync(input, adapterOverrides)
    return prepared.kind === 'refusal' ? prepared : applyGeneratedEnvironmentRepair(prepared.authority, { dryRun: prepared.dryRun })
}

function confinedPath(root: string, candidate: string): boolean {
    const relation = relative(root, candidate)
    return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

/** Whether two paths hold the same regular file bytes, are both directories, or are both absent; a link is never the same. */
function sameTrackedBytes(left: string, right: string): boolean {
    const observe = (path: string): Buffer | 'absent' | 'directory' | 'other' => {
        try {
            if (lstatSync(path).isDirectory()) return 'directory'
            const read = readBoundedFile(path, 16_777_216)
            return read.kind === 'complete' ? read.bytes : 'other'
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return 'absent'
            if (hasErrorCode(error, 'ELOOP', 'EISDIR')) return 'other'
            throw error
        }
    }
    const [a, b] = [observe(left), observe(right)]
    return Buffer.isBuffer(a) ? Buffer.isBuffer(b) && a.equals(b) : a === b && a !== 'other'
}

function bindRefusal(reason: string, fix = 'a person reviews the worktree and runs ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> there, in a terminal outside the agent'): RefusalOutcome {
    return refuse('GUARD_WORKTREE_BIND_REFUSED' satisfies typeof ENVIRONMENT_CODES.GUARD_WORKTREE_BIND_REFUSED,
        `${reason}, so the worktree's guard was not bound and nothing was written`, 'guard', fix)
}

/**
 * The first path of the main checkout that differs from what its last sync recorded, its configuration against the
 * guard identity and every whole generated file against the ownership manifest, or undefined when they all match. The bind
 * copies the main checkout's state, so that state must be the one a person synced, not one edited since.
 */
function unsyncedMainChange(main: string, identity: GuardHandlerIdentity, cockpitName: string): string | undefined {
    const digest = (path: string) => {
        try {
            const read = readBoundedFile(path, 16_777_216)
            return read.kind === 'complete' ? createHash('sha256').update(read.bytes).digest('hex') : undefined
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR')) return undefined
            throw error
        }
    }
    if (digest(identity.configPath) !== identity.configSha256) return relative(main, identity.configPath)
    let manifest
    try { manifest = readBoundedFile(join(main, OWNERSHIP_PATH), 16_777_216) }
    catch (error) { if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR')) return OWNERSHIP_PATH; throw error }
    const ownership = manifest.kind === 'complete' ? parseOwnershipManifest(manifest.bytes.toString('utf8'),
        { root: main, configPath: identity.configPath, cockpitId: publicationCockpitId({ name: cockpitName }) }) : undefined
    if (ownership?.kind !== 'complete' || ownership.manifest.source.sha256 !== identity.configSha256) return OWNERSHIP_PATH
    return ownership.manifest.entries.find(entry => entry.kind === 'file' && digest(join(main, entry.path)) !== entry.sha256)?.path
}

// A new linked worktree carries the committed cockpit files but not the machine-local identity sync binds, and its
// sync wrote nothing else. The guard lets an agent run this bind itself with the main checkout's own Node and cockpit,
// so it is the bind that proves it grants nothing that checkout's sync did not: the same cockpit and configuration
// bytes, the same sibling directories, and generated files already current. It reads each of them itself rather than
// trusting the guard's look, which a write between the two could have changed.
async function bindLinkedWorktree(request: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters>): Promise<GeneratedEnvironmentCommandOutcome> {
    const adapters = mergedAdapters(adapterOverrides)
    const publication = await preparePublication(request, adapters)
    if ('status' in publication) return publication
    if ('refusal' in publication) return publication.refusal
    const { prepared, plan } = publication
    const main = linkedWorktreeMainCheckout(prepared.root)
    if (!main) return bindRefusal(`${prepared.root} is not a linked worktree whose Git record names it back from a main checkout`)
    let mainIdentity: GuardHandlerIdentity | undefined
    try { mainIdentity = parseGuardLocalIdentity(await readFile(join(main, GUARD_LOCAL_PATHS.identity), 'utf8')) }
    catch (error) { if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return bindRefusal(`the guard identity of ${main} could not be read (${errorCause(error)})`) }
    if (!mainIdentity || mainIdentity.root !== main) return bindRefusal(`its main checkout ${main} has no guard identity of its own to bind to`)
    const running = await realpath(fileURLToPath(new URL('../../../dist/cli.js', import.meta.url)))
    if (running !== mainIdentity.module || createHash('sha256').update(await readFile(running)).digest('hex') !== mainIdentity.moduleSha256) {
        return bindRefusal(`this cockpit runs from ${running}, not ${mainIdentity.module}, the one the guard of ${main} runs`)
    }
    if (await realpath(process.execPath) !== await realpath(mainIdentity.node).catch(() => undefined)) {
        return bindRefusal(`this cockpit runs on ${process.execPath}, not ${mainIdentity.node}, the Node the guard of ${main} runs`)
    }
    if (relative(prepared.root, prepared.configPath) !== relative(main, mainIdentity.configPath)) {
        return bindRefusal(`${prepared.configPath} is not at the place in the worktree where ${main} keeps its synced configuration`)
    }
    if (prepared.sourceSha256 !== mainIdentity.configSha256) return bindRefusal(`${prepared.configPath} differs from the configuration synced in ${main}`)
    // The configuration names its siblings relative to where it lies, so the same bytes elsewhere can grant other directories.
    // A sibling inside each checkout at the same place, such as the root sibling `dir = "."`, is that checkout's own
    // directory on either side; any other must be the very same directory, or the worktree's guard would grant another.
    const siblings = await authenticateSiblingRoots(main, prepared.registry.config, mainIdentity.configPath)
    const sameSibling = (worktree: string, checkout: string | undefined) => checkout !== undefined && (worktree === checkout
        || confinedPath(prepared.root, worktree) && confinedPath(main, checkout) && relative(prepared.root, worktree) === relative(main, checkout))
    if (siblings.kind !== 'complete' || siblings.roots.siblings.size !== prepared.siblingRoots.siblings.size
        || [...prepared.siblingRoots.siblings].some(([slug, sibling]) => !sameSibling(sibling.root, siblings.roots.siblings.get(slug)?.root))) {
        return bindRefusal(`its configuration resolves its siblings to other directories from ${prepared.root} than from ${main}`)
    }
    // Rendered files do not name their checkout, so every tracked input sync reads and every file it owns must hold the
    // main checkout's bytes: a branch can commit another adopted settings copy with the files regenerated from it.
    // Inputs first, so a refusal names the cause rather than the files generated from it.
    const compared = [...new Set([relative(prepared.root, prepared.configPath),
        ...ADOPTABLE_SURFACE_PATHS.map(adoptedCopyPath), ...prepared.adoptedSources.map(source => source.path),
        ...prepared.composeSources.map(source => source.path),
        ...prepared.sourceEvidence.filter(evidence => evidence.root === prepared.root).map(evidence => evidence.path),
        OWNERSHIP_PATH, ...prepared.owned.map(row => row.path), ...prepared.surfaces.map(row => row.path),
        ...publication.ownership.kind === 'complete' ? publication.ownership.manifest.entries.map(row => row.path) : []])]
    const unsynced = unsyncedMainChange(main, mainIdentity, prepared.registry.config.cockpit.name)
    if (unsynced !== undefined) return bindRefusal(`${main} has changes its last sync did not record, starting at ${unsynced}`,
        `a person reviews the main checkout and runs ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${mainIdentity.configPath} in ${main}, in a terminal outside the agent, then the bind runs again`)
    const differing = compared.find(path => !sameTrackedBytes(join(prepared.root, path), join(main, path)))
    if (differing !== undefined) return bindRefusal(`${differing} differs from the copy in ${main}`)
    if (plan.changes.length) return bindRefusal(`its generated files are not the ones its configuration generates: sync would ${plan.changes[0]!.operation} ${plan.changes[0]!.path}`)
    // Bound to the Node and cockpit the main checkout's guard runs, which this process is.
    const guardHandler: GuardHandlerIdentity = { ...mainIdentity, root: prepared.root, rootInode: String((await lstat(prepared.root)).ino),
        configPath: prepared.configPath, configInode: String((await lstat(prepared.configPath)).ino) }
    return applyGeneratedEnvironmentRepair(issueRepairAuthority({ prepared: { ...prepared, guardHandler }, plan, adapters }))
}

// The guard refuses an agent's sync of an edit that widens it only where it proves the call starts
// cockpit, and init syncs too, so the team sync itself refuses to publish such an edit without its
// approval. It judges the bytes publication is bound to, which publication re-reads before and after
// it writes, so an edit landing after a caller classified the file cannot ride along.
async function unapprovedGuardWidening(prepared: PreparedEnvironment, approval: GuardWideningApproval | undefined): Promise<RefusalOutcome | undefined> {
    const read = await readBoundedInput(prepared.configPath)
    const config = read.kind === 'complete' && sha256(read.bytes) === prepared.sourceSha256 ? parseCockpitConfigBytes(read.bytes) : undefined
    if (!config) return refuse('GENERATED_SOURCE_CHANGED', 'the configuration changed before generated files could be published', prepared.configSource.path)
    const change = await observeGuardConfigChange(prepared.root, { sha256: prepared.sourceSha256, config })
    if (change?.kind !== 'widening' && change?.kind !== 'unrecorded') return undefined
    if (approval?.configSha256 === prepared.sourceSha256) return undefined
    const refusal = guardWideningUnconfirmedDiagnostic(change.kind === 'widening' ? change.fields : 'unrecorded', prepared.configPath)
    return refuse(refusal.code, refusal.message, refusal.target, refusal.fix)
}

export async function syncTeamGeneratedEnvironment(
    input: GeneratedEnvironmentSyncInput,
    adapterOverrides: Partial<GeneratedEnvironmentCommandAdapters> = {},
): Promise<GeneratedEnvironmentCommandOutcome> {
    const request = syncCommandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const metadata = await prepareTeamMetadata(request.configPath)
    if (metadata.kind === 'refusal') return refuse(metadata.code, metadata.message, metadata.target, metadata.fix)
    if (request.bindWorktree) {
        return metadata.authority.changes.length
            ? bindRefusal(`it would write the team metadata ${metadata.authority.changes[0]!.path}`)
            : bindLinkedWorktree(request, adapterOverrides)
    }
    const prepared = await prepareGeneratedEnvironmentSync(request, adapterOverrides, metadata.authority.changes)
    if (prepared.kind === 'refusal') return prepared
    if (!prepared.dryRun) {
        const record = issuedRepairs.get(prepared.authority)!
        const widened = await unapprovedGuardWidening(record.prepared, request.guardWidening)
        if (widened) return widened
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
            if (!await inputSourcesCurrent(prepared, adapters, deadline)) return refuse('GENERATED_SOURCE_CHANGED', 'a generated input changed before publication', stage === 'before-stage' ? prepared.configSource.path : 'generated-environment')
            return true
        },
    })
    if (outcome.kind === 'refusal') return outcome
    if (prepared.guardHandler && settings.dryRun !== true) {
        // The guard compares a later edit with exactly the text this identity names, so it is read
        // again and must still be that text.
        const configRead = await readBoundedInput(prepared.configPath)
        if (configRead.kind !== 'complete' || sha256(configRead.bytes) !== prepared.guardHandler.configSha256) return refuse('GENERATED_SOURCE_CHANGED',
            `the configuration changed after generated files were published, so the guard identity was not recorded; the guard refuses ${GUARD_HELD_CALLS} until it is`,
            prepared.configSource.path, 'run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>` again')
        const local = await writeGuardLocalIdentity(prepared.root, prepared.guardHandler, configRead.bytes.toString('utf8'))
        if (local.kind === 'refusal') return refuse('GENERATED_PUBLICATION_FAILED',
            `the committed guard files were published, but ${local.message}; the guard refuses ${GUARD_HELD_CALLS} until it exists`,
            GUARD_LOCAL_PATHS.identity, 'fix the path, then run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>` again in a terminal')
        // The hook runs the guard script only when it matches the digest recorded here, which must be the script sync
        // rendered, in the checkout it checked.
        if (String((await lstat(prepared.root)).ino) !== prepared.guardHandler.rootInode) return refuse('GENERATED_SOURCE_CHANGED',
            `the cockpit checkout ${prepared.root} was replaced while sync ran, so the guard was not recorded; the guard refuses ${GUARD_HELD_CALLS} until it is`,
            prepared.root, 'run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>` again in a terminal')
        const rendered = [...prepared.owned, ...prepared.surfaces].find(row => row.path === GUARD_SCRIPT_PATH && 'sha256' in row)
        const record = await writeGuardRecord(prepared.root, undefined, rendered && 'sha256' in rendered ? rendered.sha256 : undefined)
        if (record.kind === 'refusal') return refuse('GENERATED_PUBLICATION_FAILED',
            `the committed guard files were published, but ${record.message}; the guard refuses ${GUARD_HELD_CALLS} until it is recorded`,
            GUARD_LOCAL_PATHS.identity, 'run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>` again in a terminal')
        // A Claude Code session started below the cockpit root reads only the local settings at the root.
        const claude = await writeClaudeLocalGuard(prepared.root)
        if (claude.kind === 'refusal') return refuse('GENERATED_PUBLICATION_FAILED',
            `the committed guard files were published, but ${claude.message}; a Claude Code session started below the cockpit root runs without the guard until it is written`,
            '.claude/settings.local.json', 'make .claude/settings.local.json a JSON object or remove it, then run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>` again in a terminal')
    }
    if (prepared.openCodeGrantRoots.length > 0 && settings.dryRun !== true) {
        // A checkout `use` serves from outside the declared one is what OpenCode is granted, as `use` wrote it.
        const recorded = await readSiblingCheckouts(prepared.root)
        if (recorded.kind !== 'complete') return refuse(recorded.diagnostic.code,
            `the committed OpenCode settings were published, but its grants were not written: ${recorded.diagnostic.message}`,
            recorded.diagnostic.target, recorded.diagnostic.fix)
        const grants = prepared.openCodeGrantRoots.map(row => ({ name: basename(openCodeGrantFile(row.slug)),
            bytes: openCodeGrantDirectory(row.root, Object.hasOwn(recorded.checkouts, row.slug) ? recorded.checkouts[row.slug] : undefined) }))
        const unsafe = grants.map(row => openCodePatternUnsafe(row.bytes)).find(reason => reason !== undefined)
        if (unsafe) return refuse('GENERATED_PUBLICATION_FAILED', `the committed OpenCode settings were published, but its grants were not written: ${unsafe}`,
            GUARD_LOCAL_PATHS.directory, 'serve the sibling from a checkout at a plain path with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs use`, then run sync again')
        const local = await writeCockpitLocalFiles(prepared.root, grants)
        if (local.kind === 'refusal') return refuse('GENERATED_PUBLICATION_FAILED',
            `the committed OpenCode settings were published, but ${local.message}; OpenCode refuses to start until it exists`,
            GUARD_LOCAL_PATHS.directory, 'fix the path, then run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>` again in a terminal')
    }
    const needsApproval = outcome.staleRemoval && !staleMcpOutputsOnly(outcome.staleRemoval.entries.map(entry => entry.path), prepared.configuredHarnesses)
    return complete('sync', prepared, settings.dryRun === true, outcome.changes, settings.dryRun && needsApproval ? outcome.staleRemoval : undefined)
}
