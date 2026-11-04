/**
 * Owns the stale-stack detector: what each mounted sibling's dependencies and schema looked like
 * when the stack came up, and whether they still do. A bind mount follows a pulled branch at once,
 * but installed dependencies usually live in an image or a volume built before it and a database
 * keeps the schema it was migrated to, so a stack that kept running after a lockfile or migration
 * changed fails like a product bug and its tests pass against code nobody is running.
 *
 * It decides nothing: `up` records, `down` and a stopping `sleep` forget, and doctor and preflight
 * warn. The record is machine-local beside the sibling checkout record, under `.cockpit/local`.
 */
import { lstatIfPresent } from './presence.js'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readBoundedFile } from '../bounded-read.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { sha256Hex } from '../sha256.js'
import { GUARD_LOCAL_PATHS, writeCockpitLocalFiles } from '../guards/local-identity.js'
import type { CockpitConfig, Sibling } from '../schema.js'
import { ENVIRONMENT_CODES, errorCause, hasErrorCode, RefusalError, tryParseJson, type EnvironmentDiagnostic } from './contract.js'
import { mapLimit } from './map-limit.js'
import { servedPath, type ServedSibling } from './sibling-checkouts.js'

const FORMAT = 'cockpit-stack-inputs/v1'
const RECORD_NAME = 'stack-inputs'
const RECORD_PATH = `${GUARD_LOCAL_PATHS.directory}/${RECORD_NAME}`
const RECORD_MAX_BYTES = 1_048_576
// A migrations directory is small; one this large is the wrong path, and hashing it would stall every doctor.
const DIRECTORY_ENTRY_LIMIT = 20_000
// Each in-flight digest may hold a file descriptor.
const DIGEST_CONCURRENCY = 16

// The lockfiles the common toolchains write, watched when no install policy names the sibling's.
const COMMON_LOCKFILES: readonly string[] = Object.freeze([
    'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
    'poetry.lock', 'uv.lock', 'Pipfile.lock', 'pdm.lock', 'Gemfile.lock', 'go.sum', 'Cargo.lock',
    'composer.lock', 'packages.lock.json', 'mix.lock',
])

type StackInputSource = 'rebuild_inputs' | 'environment.install_policies' | 'common lockfile names'

interface InputDigest { readonly path: string; readonly source: StackInputSource; readonly sha256: string | null }
interface SiblingInputs { readonly slug: string; readonly served: string; readonly inputs: readonly InputDigest[] }
interface StackInputsRecord { readonly format: typeof FORMAT; readonly recordedAt: string; readonly siblings: readonly SiblingInputs[] }

// Directory hashes name each entry relative to the directory, so moving a checkout is no change.
async function digestPath(path: string): Promise<string | null> {
    let status
    try { status = await lstat(path) }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return null
        throw error
    }
    if (status.isSymbolicLink()) return sha256Hex(`link\0${await readlink(path)}`)
    if (status.isFile()) return sha256Hex(await readFile(path))
    if (!status.isDirectory()) return sha256Hex(`other\0${status.mode}`)
    const hash = createHash('sha256')
    // Entries are digested concurrently but folded into the hash in sorted order, so the digest is deterministic.
    let entries = 0
    const walk = async (directory: string, prefix: string): Promise<string[]> => {
        const listed = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : 1)
        entries += listed.length
        if (entries > DIRECTORY_ENTRY_LIMIT) throw new RefusalError(`${path} holds more than ${DIRECTORY_ENTRY_LIMIT} entries`)
        return (await mapLimit(listed, DIGEST_CONCURRENCY, async entry => {
            const relative = `${prefix}${entry.name}`
            return entry.isDirectory()
                ? [`dir\0${relative}\0`, ...await walk(join(directory, entry.name), `${relative}/`)]
                : [`${relative}\0${await digestPath(join(directory, entry.name))}\0`]
        })).flat()
    }
    for (const line of await walk(path, '')) hash.update(line)
    return hash.digest('hex')
}

async function exists(path: string): Promise<boolean> {
    return await lstatIfPresent(path) !== undefined
}

/** The paths watched for one sibling and where each came from: its own list, then the toolchain's lockfiles. */
async function watchedInputs(config: Pick<CockpitConfig, 'environment'>,
    sibling: Pick<Sibling, 'toolchain' | 'rebuild_inputs'>, served: string): Promise<readonly Readonly<{ path: string; source: StackInputSource }>[]> {
    const declared = (sibling.rebuild_inputs ?? []).map(path => ({ path, source: 'rebuild_inputs' as const }))
    const policies = config.environment.install_policies.filter(policy => policy.toolchain === sibling.toolchain)
        .map(policy => ({ path: policy.lockfile, source: 'environment.install_policies' as const }))
    // Without a policy only the lockfiles present at up are watched; one created later is a new
    // toolchain, which a person adds to install_policies.
    const common = policies.length > 0 ? [] : (await Promise.all(COMMON_LOCKFILES.map(async path =>
        await exists(join(served, path)) ? [{ path, source: 'common lockfile names' as const }] : []))).flat()
    const seen = new Set<string>()
    return [...declared, ...policies, ...common].filter(row => !seen.has(row.path) && seen.add(row.path))
}

function stackSiblings(config: Pick<CockpitConfig, 'sibling'>): readonly Sibling[] {
    return config.sibling.filter(sibling => sibling.mount === 'always' || sibling.mount.startsWith('profile:'))
}

/**
 * Record the inputs of every sibling the stack mounts; a warning, never a refusal, when that fails.
 * With `keepExisting`, a record already there stays: the stack it describes is still the one running.
 */
export async function recordStackInputs(cockpitRoot: string, config: Pick<CockpitConfig, 'sibling' | 'environment'>,
    served: ReadonlyMap<string, ServedSibling>, options: Readonly<{ keepExisting: boolean }>): Promise<readonly EnvironmentDiagnostic[]> {
    try {
        if (options.keepExisting) {
            try { await lstat(join(cockpitRoot, RECORD_PATH)); return [] }
            catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error }
        }
        const siblings: SiblingInputs[] = await Promise.all(stackSiblings(config).map(async sibling => {
            const directory = servedPath(served, sibling.slug)
            const inputs = await Promise.all((await watchedInputs(config, sibling, directory)).map(async row =>
                ({ ...row, sha256: await digestPath(join(directory, row.path)) })))
            return { slug: sibling.slug, served: directory, inputs }
        }))
        const record: StackInputsRecord = { format: FORMAT, recordedAt: new Date().toISOString(), siblings }
        const written = await writeCockpitLocalFiles(cockpitRoot, [{ name: RECORD_NAME, bytes: `${JSON.stringify(record)}\n` }])
        if (written.kind !== 'complete') throw new RefusalError(written.message)
        return []
    } catch (error) {
        return [unrecorded(`the lockfiles and declared rebuild inputs could not be recorded (${errorCause(error)})`)]
    }
}

function unrecorded(reason: string): EnvironmentDiagnostic {
    return {
        severity: 'warning',
        code: 'STACK_INPUTS_UNRECORDED' satisfies typeof ENVIRONMENT_CODES.STACK_INPUTS_UNRECORDED,
        message: `${reason}, so doctor and preflight cannot tell when this stack falls behind its siblings' dependencies or migrations`,
        target: RECORD_PATH,
        fix: `run ${cockpitCommand('down')} and ${cockpitCommand('up')} to record them again`,
    }
}

/** Forget the record once no stack runs, so a later doctor compares nothing against a stack that is gone. */
export async function forgetStackInputs(cockpitRoot: string): Promise<readonly EnvironmentDiagnostic[]> {
    try {
        await rm(join(cockpitRoot, RECORD_PATH), { force: true })
        return []
    } catch (error) {
        return [{
            severity: 'warning',
            code: 'STACK_INPUTS_UNRECORDED' satisfies typeof ENVIRONMENT_CODES.STACK_INPUTS_UNRECORDED,
            message: `the stack stopped, but ${join(cockpitRoot, RECORD_PATH)} could not be removed (${errorCause(error)}), so doctor may still compare against it`,
            target: RECORD_PATH,
            fix: `delete ${join(cockpitRoot, RECORD_PATH)}`,
        }]
    }
}

function decode(bytes: Buffer): StackInputsRecord | undefined {
    const value = tryParseJson(bytes.toString('utf8')) as Partial<StackInputsRecord> | undefined
    const text = (field: unknown) => typeof field === 'string' && field.length > 0
    if (!value || typeof value !== 'object' || value.format !== FORMAT || !text(value.recordedAt) || !Array.isArray(value.siblings)
        || !value.siblings.every(row => row && text(row.slug) && text(row.served) && Array.isArray(row.inputs)
            && row.inputs.every((input: Partial<InputDigest>) => input && text(input.path) && text(input.source) && (input.sha256 === null || text(input.sha256))))) return undefined
    return value as StackInputsRecord
}

/**
 * One warning per mounted sibling whose served checkout, lockfiles or declared rebuild inputs differ
 * from what the running stack started with. Nothing recorded means no stack came up since the last
 * `down`, and is no finding.
 */
export async function staleStackDiagnostics(cockpitRoot: string, served: ReadonlyMap<string, ServedSibling>): Promise<readonly EnvironmentDiagnostic[]> {
    const path = join(cockpitRoot, RECORD_PATH)
    let bytes: Buffer
    try {
        const read = readBoundedFile(path, RECORD_MAX_BYTES)
        if (read.kind === 'too-large') return [unrecorded(`${path} is not a record cockpit wrote`)]
        bytes = read.bytes
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return []
        if (hasErrorCode(error, 'ELOOP', 'EISDIR')) return [unrecorded(`${path} is not a record cockpit wrote`)]
        return [unrecorded(`${path} could not be read (${errorCause(error)})`)]
    }
    const record = decode(bytes)
    if (!record) return [unrecorded(`${path} is not a record cockpit wrote`)]
    const findings = await Promise.all(record.siblings.map(async (sibling): Promise<EnvironmentDiagnostic | undefined> => {
        const current = served.get(sibling.slug)
        if (!current) return undefined
        let changes: string[]
        if (current.served !== sibling.served) changes = [`it is now served from ${current.served}`]
        else {
            changes = (await mapLimit(sibling.inputs, DIGEST_CONCURRENCY, async input => {
                let digest: string | null
                try { digest = await digestPath(join(sibling.served, input.path)) }
                catch (error) { return `${input.path} (${input.source}) could not be read: ${errorCause(error)}` }
                return digest === input.sha256 ? undefined : `${input.path} (${input.source}) ${digest === null ? 'was removed' : input.sha256 === null ? 'was created' : 'changed'}`
            })).filter(change => change !== undefined)
        }
        if (changes.length === 0) return undefined
        return {
            severity: 'warning',
            code: 'STACK_INPUTS_CHANGED' satisfies typeof ENVIRONMENT_CODES.STACK_INPUTS_CHANGED,
            message: `the stack came up at ${record.recordedAt} with sibling ${sibling.slug} from ${sibling.served}; since then ${changes.join(', ')}, `
                + 'so its services may still run the old dependencies, schema or code',
            target: `sibling:${sibling.slug}`,
            fix: `run ${cockpitCommand('down')} and then ${cockpitCommand('up')} so every service starts on the current files; `
                + 'a service whose image installs the dependencies needs that image rebuilt before up',
        }
    }))
    return findings.filter(finding => finding !== undefined)
}
