import { prepareTeamMetadata, applyTeamMetadata, type TeamMetadataChange } from '../../team-metadata.js'
import { basename } from 'node:path'
import { GUARD_LOCAL_PATHS, writeCockpitLocalFiles, writeGuardLocalIdentity } from '../../guards/local-identity.js'
import { portablePublicationPaths, authorizePublicationPlan, runPublicationPlan } from '../../generated-environment/transaction.js'
import { refusalOutcome as refuse } from '../../refusal.js'
import { readBoundedInput } from '../../config/load.js'
import {
    type GeneratedEnvironmentCommandAdapters,
    type GeneratedEnvironmentCommandOutcome,
    type GeneratedEnvironmentRepairAuthority,
    type GeneratedEnvironmentSyncInput,
    type RefusalOutcome,
    complete,
    mergedAdapters,
    overrideChangedRefusal,
    ownRecord,
    sha256,
} from './shared.js'
import { syncCommandInput } from './prepare.js'
import { inputSourcesCurrent, ownedInputOverlap, preparePublication } from './publication.js'
import { checkCanonicalGeneratedEnvironment, issueRepairAuthority, issuedRepairs } from './check.js'
import { openCodeGrantFile } from './surface-outputs.js'
import { readSiblingCheckouts } from '../sibling-checkouts.js'
import { openCodeGrantDirectory, openCodePatternUnsafe } from '../served-checkout-grants.js'

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
            'the configuration changed after generated files were published, so the guard identity was not recorded; the guard refuses every agent tool call until it is',
            prepared.configSource.path, 'run `npx --no cockpit sync --config <your cockpit.toml>` again')
        const local = await writeGuardLocalIdentity(prepared.root, prepared.guardHandler, configRead.bytes.toString('utf8'))
        if (local.kind === 'refusal') return refuse('GENERATED_PUBLICATION_FAILED',
            `the committed guard files were published, but ${local.message}; the guard refuses every agent tool call until it exists`,
            GUARD_LOCAL_PATHS.identity, 'fix the path, then run `npx --no cockpit sync --config <your cockpit.toml>` again in a terminal')
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
            GUARD_LOCAL_PATHS.directory, 'serve the sibling from a checkout at a plain path with `npx --no cockpit use`, then run sync again')
        const local = await writeCockpitLocalFiles(prepared.root, grants)
        if (local.kind === 'refusal') return refuse('GENERATED_PUBLICATION_FAILED',
            `the committed OpenCode settings were published, but ${local.message}; OpenCode refuses to start until it exists`,
            GUARD_LOCAL_PATHS.directory, 'fix the path, then run `npx --no cockpit sync --config <your cockpit.toml>` again in a terminal')
    }
    return complete('sync', prepared, settings.dryRun === true, outcome.changes, settings.dryRun ? outcome.staleRemoval : undefined)
}
