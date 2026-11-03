/**
 * Owns `cockpit sync --adopt <path>`: it takes a team's existing harness settings file into cockpit
 * without losing it. The file's bytes move to `cockpit/adopted/<path>`, one `[[surfaces.adopted]]`
 * row records them in cockpit.toml, and the ordinary sync then renders the merge in its place.
 *
 * It decides whether a file may be adopted and records it; the merge rules live in
 * `surfaces/adoption.ts`, the cockpit.toml write in `config/verified-write.ts`, and publication in
 * the sync it hands off to. Filesystem access crosses the authenticated transaction helper rather
 * than introducing another runner. A sync that refuses before writing the merged file is rolled
 * back, so a refused adoption does not silently leave the team's settings moved aside.
 */
import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { parse, TomlError } from 'smol-toml'

import { loadCockpitConfig, STRUCTURED_INPUT_BYTE_LIMIT } from '../config/load.js'
import { writeVerifiedConfig } from '../config/verified-write.js'
import type { Diagnostic } from '../diagnostics.js'
import { executeProbe } from '../environment-exec/execute.js'
import { ENVIRONMENT_CODES, errorCause } from '../environment/contract.js'
import { publicationCockpitId } from '../environment/identity.js'
import { CockpitConfig, SurfaceAdoption } from '../schema.js'
import { adoptedCopyPath, inspectAdoptedSettings } from '../surfaces/adoption.js'
import { ADOPTABLE_SURFACE_PATHS, SURFACE_FILE_MAX_BYTES, type AdoptableSurfacePath } from '../surfaces/contract.js'
import { parseOwnershipManifest } from '../surfaces/ownership.js'
import { nodeAuthority, readAnchoredEntry, readAnchoredFile, relocateAnchoredFile, restoreAnchoredFile,
    type PublicationAdapters } from './transaction.js'

export const mechanism = {
    id: 'surface-adoption-command',
    module: 'packages/cockpit/src/generated-environment/adopt.ts',
    exports: ['runSyncAdoption'],
} as const

export interface SyncAdoptionInput {
    readonly configPath: string
    readonly adopt: readonly string[]
}

export interface SyncAdoptionOutcome {
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
    readonly artifact?: string | null
    readonly destination?: string | null
}

const OWNERSHIP_PATH = '.cockpit/generated-environment-ownership.json'

// A TOML parse error quotes the lines around the failure, and cockpit.toml can hold secrets that must
// not reach a refusal: name where parsing stopped, never the text there.
function tomlFailure(error: unknown): string {
    return error instanceof TomlError ? `TOML error at line ${error.line}, column ${error.column}` : errorCause(error)
}

function refused(code: string, message: string, target?: string, fix?: string): SyncAdoptionOutcome {
    return Object.freeze({ status: 2, result: null, diagnostics: Object.freeze([Object.freeze({
        severity: 'error' as const, code, message, ...(target === undefined ? {} : { target }), ...(fix === undefined ? {} : { fix }) })]) })
}

const ADOPT_BY_HAND_FIX = 'move the settings file to cockpit/adopted/<the same path>, add its [[surfaces.adopted]] row to cockpit.toml by hand with the fields the configuration reference lists, then run npx --no cockpit sync --config <your cockpit.toml>'

/** Key order must not matter when two parsed configurations are compared. */
function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : 1)) : item)
}

function digest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

function adoptionTable(row: SurfaceAdoption): string {
    return [
        '[[surfaces.adopted]]',
        `path = ${JSON.stringify(row.path)}`,
        `source = ${JSON.stringify(row.source)}`,
        `sha256 = ${JSON.stringify(row.sha256)}`,
        `adopted_on = ${JSON.stringify(row.adopted_on)}`,
        `provenance = { source = ${JSON.stringify(row.provenance.source)}, observed_on = ${JSON.stringify(row.provenance.observed_on)}, kind = "declared", reason = ${JSON.stringify(row.provenance.reason)} }`,
    ].join('\n')
}

interface Candidate {
    readonly path: AdoptableSurfacePath
    readonly target: string
    readonly destination: string
    readonly sha256: string
}

type AdoptionNode = NonNullable<Awaited<ReturnType<typeof nodeAuthority>>>

/** Validate one requested path completely before anything moves. */
async function candidate(
    root: string,
    requested: string,
    owned: ReadonlySet<string>,
    adopted: ReadonlySet<string>,
    node: AdoptionNode,
    adapters: PublicationAdapters,
): Promise<Candidate | SyncAdoptionOutcome> {
    if (!(ADOPTABLE_SURFACE_PATHS as readonly string[]).includes(requested)) {
        return refused('CLI_USAGE_INVALID', `--adopt ${JSON.stringify(requested)} is not an adoptable harness settings file; adoptable: ${ADOPTABLE_SURFACE_PATHS.join(', ')}`, '--adopt')
    }
    const path = requested as AdoptableSurfacePath
    const destinationPath = adoptedCopyPath(path)
    if (adopted.has(path)) {
        return refused('SURFACE_ADOPTION_REFUSED', `${path} is already adopted from ${destinationPath}. Delete the duplicate ${path} and run npx --no cockpit sync --config <your cockpit.toml>; its settings are kept in ${destinationPath}`, path)
    }
    if (owned.has(path)) return refused('SURFACE_ADOPTION_REFUSED', `${path} is cockpit's own published output, not a team file; nothing to adopt`, path)
    const target = path
    const source = await readAnchoredFile(root, target, SURFACE_FILE_MAX_BYTES, node, adapters)
    if (source.kind === 'missing') return refused('SURFACE_ADOPTION_REFUSED', `${path} does not exist; there is nothing to adopt`, path)
    if (source.kind !== 'complete') {
        return refused('SURFACE_ADOPTION_REFUSED', `${path} could not be read as one stable regular file no larger than ${SURFACE_FILE_MAX_BYTES} bytes. Replace links, special files, or oversized content with the plain settings file inside the cockpit root, then re-run npx --no cockpit sync --config <your cockpit.toml> --adopt ${path}`, path)
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes) } catch {
        // undecodable bytes are malformed input the caller refuses.
        return refused('SURFACE_ADOPTION_REFUSED', `${path} is not UTF-8 text`, path)
    }
    const inspected = inspectAdoptedSettings(path, text, path)
    if (inspected.kind !== 'complete') return refused(inspected.diagnostic.code, inspected.diagnostic.message, inspected.diagnostic.target)
    const destination = await readAnchoredEntry(root, destinationPath, SURFACE_FILE_MAX_BYTES, node, adapters)
    if (destination.kind === 'invalid') return refused('SURFACE_ADOPTION_REFUSED', `${destinationPath} could not be confirmed missing through plain directories inside the cockpit root. Remove links, special files, oversized files, or unstable entries on that path, then re-run npx --no cockpit sync --config <your cockpit.toml> --adopt ${path}`, path)
    if (destination.kind !== 'missing') return refused('SURFACE_ADOPTION_REFUSED', `${destinationPath} already exists; move it aside before adopting ${path}`, destinationPath)
    return { path, target, destination: destinationPath, sha256: source.sha256 }
}

async function ownedPaths(
    root: string,
    configPath: string,
    name: string,
    node: AdoptionNode,
    adapters: PublicationAdapters,
): Promise<ReadonlySet<string> | SyncAdoptionOutcome> {
    const read = await readAnchoredFile(root, OWNERSHIP_PATH, STRUCTURED_INPUT_BYTE_LIMIT, node, adapters)
    if (read.kind === 'missing') return new Set()
    if (read.kind !== 'complete') return refused('GENERATED_OWNERSHIP_INVALID', `generated ownership metadata could not be read as one stable regular file no larger than ${STRUCTURED_INPUT_BYTE_LIMIT} bytes. Restore a plain ${OWNERSHIP_PATH} inside the cockpit root or remove the invalid entry, then re-run the command`, OWNERSHIP_PATH)
    let bytes: string
    try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) } catch {
        // undecodable bytes are malformed input the caller refuses.
        return refused('GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata is not UTF-8 text, so whether a file is cockpit\'s own cannot be decided', OWNERSHIP_PATH)
    }
    const manifest = parseOwnershipManifest(bytes, { root, cockpitId: publicationCockpitId({ name }), configPath })
    if (manifest.kind !== 'complete') return refused('GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata is unreadable, so whether a file is cockpit\'s own cannot be decided', OWNERSHIP_PATH)
    return new Set(manifest.manifest.entries.map(entry => entry.path))
}

/** Undo the moves, newest first. Every failure is reported; none is swallowed. */
async function restoreMoves(root: string, moved: readonly Candidate[], node: AdoptionNode, adapters: PublicationAdapters): Promise<string[]> {
    const failures: string[] = []
    for (const item of [...moved].reverse()) {
        try {
            const restored = await restoreAnchoredFile(root, item.target, item.destination, SURFACE_FILE_MAX_BYTES, item.sha256, node, adapters)
            if (restored.kind !== 'complete') failures.push(`${adoptedCopyPath(item.path)} could not be safely moved back to ${item.path}. Preserve both paths; restore the file whose SHA-256 is ${item.sha256} to ${item.path}, then re-run the command`)
        } catch (error) {
            failures.push(`${adoptedCopyPath(item.path)} could not be safely moved back to ${item.path} (${errorCause(error)}). Preserve both paths; restore the file whose SHA-256 is ${item.sha256} to ${item.path}, then re-run the command`)
        }
    }
    return failures
}

export async function runSyncAdoption(
    input: SyncAdoptionInput,
    synchronize: (input: Readonly<{ configPath: string }>) => Promise<SyncAdoptionOutcome>,
    adapterOverrides: Partial<PublicationAdapters> = {},
): Promise<SyncAdoptionOutcome> {
    if (input.adopt.length === 0 || new Set(input.adopt).size !== input.adopt.length) {
        return refused('CLI_USAGE_INVALID', 'name each harness settings file to adopt once with --adopt <path>', '--adopt')
    }
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return Object.freeze({ status: 2, result: null, diagnostics: loaded.diagnostics })
    const configPath = loaded.result.source.path
    const root = dirname(configPath)
    const config = loaded.result.config
    const node = await nodeAuthority()
    if (!node) return refused('GENERATED_EXECUTABLE_UNAVAILABLE', 'adoption requires an authenticated Node filesystem helper; reinstall cockpit and re-run the command', process.execPath)
    const adapters: PublicationAdapters = Object.freeze({ execute: adapterOverrides.execute ?? executeProbe })
    const owned = await ownedPaths(root, configPath, config.cockpit.name, node, adapters)
    if (!(owned instanceof Set)) return owned as SyncAdoptionOutcome
    const already = new Set(config.surfaces.adopted.map(row => row.path))
    const candidates: Candidate[] = []
    for (const requested of input.adopt) {
        const checked = await candidate(root, requested, owned, already, node, adapters)
        if ('status' in checked) return checked
        candidates.push(checked)
    }

    const original = await readAnchoredFile(root, basename(configPath), STRUCTURED_INPUT_BYTE_LIMIT, node, adapters)
    if (original.kind !== 'complete' || original.sha256 !== loaded.result.source.sha256) {
        return refused(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION, 'cockpit.toml changed while it was being read; nothing was moved. Re-run the command', configPath)
    }
    const originalText = new TextDecoder('utf-8', { fatal: true }).decode(original.bytes)
    const adoptedOn = new Date().toISOString().slice(0, 10)
    const rows = candidates.map(item => SurfaceAdoption.parse({
        path: item.path, source: adoptedCopyPath(item.path), sha256: item.sha256, adopted_on: adoptedOn,
        provenance: { source: item.path, observed_on: adoptedOn, kind: 'declared', reason: 'the team\'s own harness settings, moved aside by cockpit sync --adopt and merged with cockpit\'s rendering' },
    }))
    const nextText = `${originalText}${originalText.endsWith('\n') ? '' : '\n'}${rows.map(row => `\n${adoptionTable(row)}\n`).join('')}`
    const expected = { ...config, surfaces: { ...config.surfaces, adopted: [...config.surfaces.adopted, ...rows] } }
    let candidateConfig
    try { candidateConfig = CockpitConfig.safeParse(parse(nextText)) } catch (error) {
        return refused(ENVIRONMENT_CODES.CONFIG_PARSE_INVALID, `recording the adoption would leave cockpit.toml unparseable (${tomlFailure(error)}); nothing was moved`, configPath, ADOPT_BY_HAND_FIX)
    }
    if (!candidateConfig.success || canonical(candidateConfig.data) !== canonical(expected)) {
        return refused(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, 'recording the adoption would change more than the [[surfaces.adopted]] rows; nothing was moved', configPath, ADOPT_BY_HAND_FIX)
    }

    const moved: Candidate[] = []
    const rollback = async (
        reason: SyncAdoptionOutcome,
        configState: 'unchanged' | 'written' | 'unknown',
        uncertainty: readonly Readonly<{ item: Candidate; retainedPaths: readonly string[] }>[] = [],
    ): Promise<SyncAdoptionOutcome> => {
        const failures = await restoreMoves(root, moved, node, adapters)
        let restoreConfig = configState === 'written'
        if (configState === 'unknown') {
            try {
                const current = await readAnchoredFile(root, basename(configPath), STRUCTURED_INPUT_BYTE_LIMIT, node, adapters)
                if (current.kind === 'complete' && current.sha256 === digest(originalText)) restoreConfig = false
                else if (current.kind === 'complete' && current.sha256 === digest(nextText)) restoreConfig = true
                else failures.push(`cockpit.toml could not be matched to either the original or adopted configuration. Preserve it and restore the version whose SHA-256 is ${digest(originalText)} before retrying`)
            } catch (error) {
                failures.push(`cockpit.toml could not be checked after the failed write (${errorCause(error)}). Preserve it and restore the version whose SHA-256 is ${digest(originalText)} before retrying`)
            }
        }
        if (restoreConfig) {
            try {
                const restored = await writeVerifiedConfig({
                    path: configPath, expectedSha256: digest(nextText), temporaryTag: 'adopt',
                    edit: () => originalText,
                    isExactChange: (value) => canonical(value) === canonical(config),
                    messages: (() => {
                        const fix = `restore cockpit.toml to SHA-256 ${digest(originalText)} before retrying`
                        return {
                            changedBefore: { message: 'cockpit.toml changed after the adoption was recorded, so its [[surfaces.adopted]] rows were left in place', fix },
                            changedDuring: { message: 'cockpit.toml changed while the adoption was being undone, so its [[surfaces.adopted]] rows were left in place', fix },
                            invalid: (detail: string) => ({ message: `undoing the adoption would leave cockpit.toml invalid (${detail})`, fix }),
                            notExact: { message: 'undoing the adoption would change more than the [[surfaces.adopted]] rows', fix },
                            writtenMismatch: { message: 'cockpit.toml was restored, but re-reading it shows a further change', fix },
                        }
                    })(),
                })
                if (restored.kind !== 'complete') failures.push(`${restored.message}. ${restored.fix}`)
            } catch (error) {
                failures.push(`cockpit.toml restoration failed (${errorCause(error)}). Restore cockpit.toml to SHA-256 ${digest(originalText)} before retrying`)
            }
        }
        for (const retained of uncertainty) failures.push(`recovery remains indeterminate for ${retained.item.path}. Preserve ${[retained.item.path, ...retained.retainedPaths].join(', ')} until the original inode is confirmed at ${retained.item.path} with SHA-256 ${retained.item.sha256}`)
        const note = failures.length === 0
            ? `the adoption was rolled back: ${candidates.map(item => item.path).join(', ')} ${candidates.length === 1 ? 'is' : 'are'} back in place and cockpit.toml is unchanged`
            : `the adoption could not be fully rolled back: ${failures.join('; ')}`
        return Object.freeze({ ...reason, status: reason.status === 0 ? 2 : reason.status, diagnostics: Object.freeze([...reason.diagnostics,
            Object.freeze({ severity: 'error' as const, code: 'SURFACE_ADOPTION_REFUSED', message: note, target: candidates[0]!.path })]) })
    }
    for (const item of candidates) {
        const relocated = await relocateAnchoredFile(root, item.target, item.destination, SURFACE_FILE_MAX_BYTES, item.sha256, node, adapters)
        if (relocated.kind !== 'complete') {
            if (relocated.recovery === 'indeterminate') moved.push(item)
            const failure = relocated.failure ? ` Filesystem refusal: ${relocated.failure}.` : ''
            const recoveryFailures = relocated.recoveryFailures?.length ? ` Recovery refusals: ${relocated.recoveryFailures.join(', ')}.` : ''
            return rollback(refused('SURFACE_ADOPTION_REFUSED', relocated.recovery === 'unchanged'
                ? `${item.path} or its adopted-copy destination changed while it was being adopted; nothing was moved.${failure}`
                : `${item.path} could not be confirmed after the filesystem helper stopped; recovery was attempted.${failure}${recoveryFailures}`, item.path), 'unchanged',
            relocated.recovery === 'indeterminate' ? [{ item, retainedPaths: relocated.retainedPaths ?? [] }] : [])
        }
        moved.push(item)
    }
    const rerun = `npx --no cockpit sync --config <your cockpit.toml> ${input.adopt.map(path => `--adopt ${path}`).join(' ')}`
    let written
    try {
        written = await writeVerifiedConfig({
            path: configPath, expectedSha256: loaded.result.source.sha256, temporaryTag: 'adopt',
            edit: () => nextText,
            isExactChange: (value) => canonical(value) === canonical(expected),
            messages: {
                changedBefore: { message: 'cockpit.toml changed since it was read', fix: `let the other edit finish, then have a human approve ${rerun} again` },
                changedDuring: { message: 'cockpit.toml changed while the adoption was being recorded', fix: `let the other edit finish, then have a human approve ${rerun} again` },
                invalid: (detail) => ({ message: `recording the adoption would leave cockpit.toml invalid (${detail})`,
                    fix: `correct what the message names in cockpit.toml, then have a human approve ${rerun} again` }),
                notExact: { message: 'recording the adoption would change more than the [[surfaces.adopted]] rows', fix: ADOPT_BY_HAND_FIX },
                writtenMismatch: { message: 'the adoption was recorded, but re-reading cockpit.toml shows a further change',
                    fix: 'review cockpit.toml for the change you did not make before running npx --no cockpit sync --config <your cockpit.toml>' },
            },
        })
    } catch (error) {
        return rollback(refused('SURFACE_ADOPTION_REFUSED', `writing cockpit.toml failed (${errorCause(error)}); owned recovery was attempted. Verify cockpit.toml has SHA-256 ${digest(originalText)} before retrying`, configPath), 'unknown')
    }
    if (written.kind !== 'complete') return rollback(refused(written.code, written.message, configPath, written.fix), 'unknown')

    let synced: SyncAdoptionOutcome
    try { synced = await synchronize({ configPath }) } catch (error) {
        return rollback(refused('SURFACE_ADOPTION_REFUSED', `synchronization failed (${errorCause(error)}); owned recovery was attempted. Inspect ${candidates.map(item => item.path).join(', ')} and cockpit.toml before retrying`, configPath), 'written')
    }
    if (synced.status !== 0) {
        let published: boolean[]
        try {
            published = await Promise.all(candidates.map(item => readAnchoredEntry(root, item.target, SURFACE_FILE_MAX_BYTES, node, adapters)
                .then(entry => entry.kind !== 'missing')))
        } catch (error) {
            return rollback(refused('SURFACE_ADOPTION_REFUSED', `published settings could not be checked after synchronization refused (${errorCause(error)}); owned recovery was attempted`, candidates[0]!.path), 'written')
        }
        // A merged file already on disk is consistent with the recorded adoption; undo only a sync that wrote nothing.
        if (published.every(present => !present)) return rollback(synced, 'written')
        return synced
    }
    const result = synced.result !== null && typeof synced.result === 'object' && !Array.isArray(synced.result) ? synced.result : {}
    return Object.freeze({ ...synced, result: Object.freeze({ ...result, adopted: Object.freeze(rows.map(row => Object.freeze({
        path: row.path, source: resolve(root, row.source), sha256: row.sha256 }))) }) })
}
