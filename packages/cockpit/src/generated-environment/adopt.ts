/**
 * Owns `cockpit sync --adopt <path>`: it takes a team's existing harness settings file into cockpit
 * without losing it. The file's bytes move to `cockpit/adopted/<path>`, one `[[surfaces.adopted]]`
 * row records them in cockpit.toml, and the ordinary sync then renders the merge in its place.
 *
 * It decides whether a file may be adopted and records it; the merge rules live in
 * `surfaces/adoption.ts`, the cockpit.toml write in `config/verified-write.ts`, and publication in
 * the sync it hands off to. It spawns no process. A sync that refuses before writing the merged file
 * is rolled back, so a refused adoption never leaves the team's settings moved aside.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'smol-toml'

import { loadCockpitConfig } from '../config/load.js'
import { writeVerifiedConfig } from '../config/verified-write.js'
import type { Diagnostic } from '../diagnostics.js'
import { ENVIRONMENT_CODES } from '../environment/contract.js'
import { publicationCockpitId } from '../environment/identity.js'
import { CockpitConfig, SurfaceAdoption } from '../schema.js'
import { adoptedCopyPath, inspectAdoptedSettings } from '../surfaces/adoption.js'
import { ADOPTABLE_SURFACE_PATHS, SURFACE_FILE_MAX_BYTES, type AdoptableSurfacePath } from '../surfaces/contract.js'
import { parseOwnershipManifest } from '../surfaces/ownership.js'

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

function refused(code: string, message: string, target?: string): SyncAdoptionOutcome {
    return Object.freeze({ status: 2, result: null, diagnostics: Object.freeze([Object.freeze({
        severity: 'error' as const, code, message, ...(target === undefined ? {} : { target }) })]) })
}

/** Key order must not matter when two parsed configurations are compared. */
function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : 1)) : item)
}

function digest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

async function absent(path: string): Promise<boolean> {
    try {
        await lstat(path)
        return false
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
        throw error
    }
}

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

/** Validate one requested path completely before anything moves. */
async function candidate(root: string, requested: string, owned: ReadonlySet<string>, adopted: ReadonlySet<string>): Promise<Candidate | SyncAdoptionOutcome> {
    if (!(ADOPTABLE_SURFACE_PATHS as readonly string[]).includes(requested)) {
        return refused('CLI_USAGE_INVALID', `--adopt ${JSON.stringify(requested)} is not an adoptable harness settings file; adoptable: ${ADOPTABLE_SURFACE_PATHS.join(', ')}`, '--adopt')
    }
    const path = requested as AdoptableSurfacePath
    const destinationPath = adoptedCopyPath(path)
    if (adopted.has(path)) {
        return refused('SURFACE_ADOPTION_REFUSED', `${path} is already adopted from ${destinationPath}. Delete the duplicate ${path} and run cockpit sync; its settings are kept in ${destinationPath}`, path)
    }
    if (owned.has(path)) return refused('SURFACE_ADOPTION_REFUSED', `${path} is cockpit's own published output, not a team file; nothing to adopt`, path)
    const target = join(root, path)
    let status
    try { status = await lstat(target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return refused('SURFACE_ADOPTION_REFUSED', `${path} does not exist; there is nothing to adopt`, path)
        throw error
    }
    if (!status.isFile() || status.isSymbolicLink() || await realpath(target) !== target) {
        return refused('SURFACE_ADOPTION_REFUSED', `${path} is not a regular file inside the cockpit root; adopt only the file itself, not a link to it`, path)
    }
    if (status.size > SURFACE_FILE_MAX_BYTES) return refused('SURFACE_ADOPTION_REFUSED', `${path} exceeds the ${SURFACE_FILE_MAX_BYTES}-byte surface limit`, path)
    const bytes = await readFile(target)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
        return refused('SURFACE_ADOPTION_REFUSED', `${path} is not UTF-8 text`, path)
    }
    const inspected = inspectAdoptedSettings(path, text, path)
    if (inspected.kind !== 'complete') return refused(inspected.diagnostic.code, inspected.diagnostic.message, inspected.diagnostic.target)
    const destination = join(root, destinationPath)
    if (!await absent(destination)) return refused('SURFACE_ADOPTION_REFUSED', `${destinationPath} already exists; move it aside before adopting ${path}`, destinationPath)
    return { path, target, destination, sha256: digest(bytes) }
}

async function ownedPaths(root: string, configPath: string, name: string): Promise<ReadonlySet<string> | SyncAdoptionOutcome> {
    let bytes: string
    try { bytes = await readFile(join(root, OWNERSHIP_PATH), 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
        throw error
    }
    const manifest = parseOwnershipManifest(bytes, { root, cockpitId: publicationCockpitId({ name }), configPath })
    if (manifest.kind !== 'complete') return refused('GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata is unreadable, so whether a file is cockpit\'s own cannot be decided', OWNERSHIP_PATH)
    return new Set(manifest.manifest.entries.map(entry => entry.path))
}

/** Undo the moves, newest first. Every failure is reported; none is swallowed. */
async function restoreMoves(moved: readonly Candidate[]): Promise<string[]> {
    const failures: string[] = []
    for (const item of [...moved].reverse()) {
        try {
            if (!await absent(item.target)) {
                failures.push(`${item.path} exists again, so ${adoptedCopyPath(item.path)} was left in place`)
                continue
            }
            await rename(item.destination, item.target)
        } catch (error) {
            failures.push(`${adoptedCopyPath(item.path)} could not be moved back to ${item.path} (${error instanceof Error ? error.message : String(error)})`)
        }
    }
    return failures
}

export async function runSyncAdoption(
    input: SyncAdoptionInput,
    synchronize: (input: Readonly<{ configPath: string }>) => Promise<SyncAdoptionOutcome>,
): Promise<SyncAdoptionOutcome> {
    if (input.adopt.length === 0 || new Set(input.adopt).size !== input.adopt.length) {
        return refused('CLI_USAGE_INVALID', 'name each harness settings file to adopt once with --adopt <path>', '--adopt')
    }
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return Object.freeze({ status: 2, result: null, diagnostics: loaded.diagnostics })
    const configPath = loaded.result.source.path
    const root = dirname(configPath)
    const config = loaded.result.config
    const owned = await ownedPaths(root, configPath, config.cockpit.name)
    if (!(owned instanceof Set)) return owned as SyncAdoptionOutcome
    const already = new Set(config.surfaces.adopted.map(row => row.path))
    const candidates: Candidate[] = []
    for (const requested of input.adopt) {
        const checked = await candidate(root, requested, owned, already)
        if ('status' in checked) return checked
        candidates.push(checked)
    }

    const original = await readFile(configPath)
    if (digest(original) !== loaded.result.source.sha256) {
        return refused(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION, 'cockpit.toml changed while it was being read; nothing was moved. Re-run the command', configPath)
    }
    const originalText = original.toString('utf8')
    const adoptedOn = new Date().toISOString().slice(0, 10)
    const rows = candidates.map(item => SurfaceAdoption.parse({
        path: item.path, source: adoptedCopyPath(item.path), sha256: item.sha256, adopted_on: adoptedOn,
        provenance: { source: item.path, observed_on: adoptedOn, kind: 'declared', reason: 'the team\'s own harness settings, moved aside by cockpit sync --adopt and merged with cockpit\'s rendering' },
    }))
    const nextText = `${originalText}${originalText.endsWith('\n') ? '' : '\n'}${rows.map(row => `\n${adoptionTable(row)}\n`).join('')}`
    const expected = { ...config, surfaces: { ...config.surfaces, adopted: [...config.surfaces.adopted, ...rows] } }
    let candidateConfig
    try { candidateConfig = CockpitConfig.safeParse(parse(nextText)) } catch (error) {
        return refused(ENVIRONMENT_CODES.CONFIG_PARSE_INVALID, `recording the adoption would leave cockpit.toml unparseable (${error instanceof Error ? error.message.split('\n', 1)[0] : 'unknown'}); nothing was moved. Add the [[surfaces.adopted]] row by hand`, configPath)
    }
    if (!candidateConfig.success || canonical(candidateConfig.data) !== canonical(expected)) {
        return refused(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, 'recording the adoption would change more than the [[surfaces.adopted]] rows; nothing was moved. Add the rows by hand', configPath)
    }

    const moved: Candidate[] = []
    const rollback = async (reason: SyncAdoptionOutcome, configWritten: boolean): Promise<SyncAdoptionOutcome> => {
        const failures = await restoreMoves(moved)
        if (configWritten) {
            const restored = await writeVerifiedConfig({
                path: configPath, expectedSha256: digest(nextText), temporaryTag: 'adopt',
                edit: () => originalText,
                isExactChange: (value) => canonical(value) === canonical(config),
                messages: {
                    changedBefore: 'cockpit.toml changed after the adoption was recorded, so its [[surfaces.adopted]] rows were left in place',
                    changedDuring: 'cockpit.toml changed while the adoption was being undone, so its [[surfaces.adopted]] rows were left in place',
                    invalid: (detail) => `undoing the adoption would leave cockpit.toml invalid (${detail})`,
                    notExact: 'undoing the adoption would change more than the [[surfaces.adopted]] rows',
                    writtenMismatch: 'cockpit.toml was restored, but re-reading it shows a further change',
                },
            })
            if (restored.kind !== 'complete') failures.push(restored.message)
        }
        const note = failures.length === 0
            ? `the adoption was rolled back: ${candidates.map(item => item.path).join(', ')} ${candidates.length === 1 ? 'is' : 'are'} back in place and cockpit.toml is unchanged`
            : `the adoption could not be fully rolled back: ${failures.join('; ')}`
        return Object.freeze({ ...reason, status: reason.status === 0 ? 2 : reason.status, diagnostics: Object.freeze([...reason.diagnostics,
            Object.freeze({ severity: 'error' as const, code: 'SURFACE_ADOPTION_REFUSED', message: note, target: candidates[0]!.path })]) })
    }
    for (const item of candidates) {
        await mkdir(dirname(item.destination), { recursive: true })
        await rename(item.target, item.destination)
        moved.push(item)
        const copied = await readFile(item.destination)
        if (digest(copied) !== item.sha256) {
            return rollback(refused('SURFACE_ADOPTION_REFUSED', `${item.path} changed while it was being adopted`, item.path), false)
        }
    }
    const written = await writeVerifiedConfig({
        path: configPath, expectedSha256: loaded.result.source.sha256, temporaryTag: 'adopt',
        edit: () => nextText,
        isExactChange: (value) => canonical(value) === canonical(expected),
        messages: {
            changedBefore: 'cockpit.toml changed since it was read; re-run cockpit sync --adopt',
            changedDuring: 'cockpit.toml changed while the adoption was being recorded; re-run cockpit sync --adopt',
            invalid: (detail) => `recording the adoption would leave cockpit.toml invalid (${detail})`,
            notExact: 'recording the adoption would change more than the [[surfaces.adopted]] rows; add the rows by hand',
            writtenMismatch: 'the adoption was recorded, but re-reading cockpit.toml shows a further change; inspect it before running sync',
        },
    })
    if (written.kind !== 'complete') return rollback(refused(written.code, written.message, configPath), false)

    const synced = await synchronize({ configPath })
    if (synced.status !== 0) {
        const published = await Promise.all(candidates.map(item => absent(item.target).then(missing => !missing)))
        // A merged file already on disk is consistent with the recorded adoption; undo only a sync that wrote nothing.
        if (published.every(present => !present)) return rollback(synced, true)
        return synced
    }
    const result = synced.result !== null && typeof synced.result === 'object' && !Array.isArray(synced.result) ? synced.result : {}
    return Object.freeze({ ...synced, result: Object.freeze({ ...result, adopted: Object.freeze(rows.map(row => Object.freeze({
        path: row.path, source: resolve(root, row.source), sha256: row.sha256 }))) }) })
}
