import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCockpitConfig, readBoundedInput } from './config/load.js'
import { ENVIRONMENT_CODES, type EnvironmentDiagnostic } from './environment/contract.js'
import type { CockpitConfig } from './schema.js'
import { installedPackageMetadata } from './package-metadata.js'
import { cockpitCommand } from './fix-catalogue.js'

export const mechanism = {
    id: 'team-metadata', module: 'packages/cockpit/src/team-metadata.ts',
    exports: ['initializeTeamMetadata', 'prepareTeamMetadata', 'applyTeamMetadata', 'validateTeamMetadata', 'productPackageManifest'],
} as const

const PACKAGE = installedPackageMetadata.name
const VERSION = installedPackageMetadata.version
const INSTALLED_PACKAGE_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const SCRIPTS = Object.freeze({
    'cockpit:setup': 'cockpit setup --config cockpit.toml',
    'cockpit:sync': 'cockpit sync --config cockpit.toml',
    'cockpit:check': 'cockpit check --config cockpit.toml',
})
const START = '# cockpit:ignore:start'
const END = '# cockpit:ignore:end'
const OTHER_DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

export interface TeamMetadataChange {
    readonly operation: 'write'
    readonly path: string
}

export type TeamMetadataResult = Readonly<{ kind: 'complete'; changed: boolean; changes: readonly TeamMetadataChange[] }>
    | Readonly<{ kind: 'refusal'; code: EnvironmentDiagnostic['code']; message: string; target: string; fix?: string }>

function refuse(code: typeof ENVIRONMENT_CODES.TEAM_METADATA_UNAVAILABLE | typeof ENVIRONMENT_CODES.COCKPIT_VERSION_MISMATCH,
    message: string, target: string): Extract<TeamMetadataResult, { kind: 'refusal' }> {
    return { kind: 'refusal', code, message, target }
}

// The loader already names the failing key and reason; replacing it with a generic refusal left
// sync reporting "cockpit.toml must be valid" for every malformed configuration.
function configRefusal(loaded: Awaited<ReturnType<typeof loadCockpitConfig>>, configPath: string): Extract<TeamMetadataResult, { kind: 'refusal' }> {
    const reason = loaded.diagnostics.find(diagnostic => diagnostic.severity === 'error')
    if (!reason) return refuse('TEAM_METADATA_UNAVAILABLE', 'cockpit.toml could not be loaded and the loader gave no reason', configPath)
    return { kind: 'refusal', code: reason.code, message: reason.message, target: reason.target ?? configPath, ...(reason.fix ? { fix: reason.fix } : {}) }
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface RootAuthority {
    readonly root: string
    readonly chain: readonly Readonly<{ path: string; dev: number; ino: number }>[]
}

async function captureRoot(root: string): Promise<RootAuthority> {
    if (await realpath(root) !== root) throw new Error('cockpit root is not canonical')
    const chain: Array<{ path: string; dev: number; ino: number }> = []
    for (let path = root;; path = dirname(path)) {
        const status = await lstat(path)
        if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('cockpit root ancestry is redirected')
        chain.push({ path, dev: status.dev, ino: status.ino })
        if (dirname(path) === path) break
        if (chain.length >= 64) throw new Error('cockpit root ancestry exceeds the verification bound')
    }
    return Object.freeze({ root, chain: Object.freeze(chain) })
}

async function authenticateRoot(authority: RootAuthority): Promise<void> {
    if (await realpath(authority.root) !== authority.root) throw new Error('cockpit root was redirected')
    for (const expected of authority.chain) {
        const status = await lstat(expected.path)
        if (!status.isDirectory() || status.isSymbolicLink() || status.dev !== expected.dev || status.ino !== expected.ino) {
            throw new Error('cockpit root ancestry changed')
        }
    }
}

async function readOptional(authority: RootAuthority, path: string): Promise<Readonly<{ bytes: string; mode: number; identity: string }> | undefined> {
    if (dirname(path) !== authority.root) throw new Error('team metadata escaped the cockpit root')
    await authenticateRoot(authority)
    try {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file')
        const read = await readBoundedInput(path)
        if (read.kind !== 'complete') throw new Error('file exceeds the input limit')
        await authenticateRoot(authority)
        return { bytes: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes), mode: stat.mode,
            identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(read.bytes).digest('hex')}` }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await authenticateRoot(authority)
            return undefined
        }
        throw error
    }
}

async function replaceAuthenticated(authority: RootAuthority, path: string, before: Awaited<ReturnType<typeof readOptional>>, bytes: string): Promise<void> {
    const directory = dirname(path)
    if (directory !== authority.root) throw new Error('team metadata escaped the cockpit root')
    const temporary = join(directory, `.${path.slice(path.lastIndexOf('/') + 1)}.cockpit-${randomBytes(8).toString('hex')}`)
    let created = false
    try {
        await authenticateRoot(authority)
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            before?.mode ?? 0o644)
        created = true
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        await authenticateRoot(authority)
        const current = await readOptional(authority, path)
        if (current?.identity !== before?.identity) throw new Error('file changed before replacement')
        await authenticateRoot(authority)
        await rename(temporary, path)
        created = false
        await authenticateRoot(authority)
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
            const status = await parent.stat()
            const expected = authority.chain[0]!
            if (!status.isDirectory() || status.dev !== expected.dev || status.ino !== expected.ino) throw new Error('cockpit root changed before sync')
            await parent.sync()
        } finally { await parent.close() }
    } finally {
        if (created) {
            await authenticateRoot(authority)
            await unlink(temporary)
        }
    }
}

/**
 * The package manifest without the entries sync owns in it: the cockpit dependency, under any spec,
 * and each cockpit script while it is the exact command sync writes. Sections those removals leave
 * empty are dropped, so a manifest cockpit created and one it edited project the same way.
 */
export function productPackageManifest(manifest: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const product: Record<string, unknown> = { ...manifest }
    if (object(manifest.devDependencies)) {
        const { [PACKAGE]: _pin, ...rest } = manifest.devDependencies
        product.devDependencies = rest
    }
    if (object(manifest.scripts)) product.scripts = Object.fromEntries(Object.entries(manifest.scripts)
        .filter(([name, command]) => (SCRIPTS as Record<string, string>)[name] !== command))
    for (const section of ['devDependencies', 'scripts'] as const) {
        const value = product[section]
        if (object(value) && Object.keys(value).length === 0) delete product[section]
    }
    return product
}

interface PackageDependencySlots {
    readonly devDependencies: Record<string, unknown>
    readonly misplaced: readonly string[]
}

function packageDependencySlots(manifest: Record<string, unknown>): PackageDependencySlots | undefined {
    const devDependencies = manifest.devDependencies === undefined ? {} : manifest.devDependencies
    if (!object(devDependencies)) return undefined
    const misplaced: string[] = []
    for (const section of OTHER_DEPENDENCY_SECTIONS) {
        const dependencies = manifest[section]
        if (dependencies !== undefined && !object(dependencies)) return undefined
        if (object(dependencies) && dependencies[PACKAGE] !== undefined) misplaced.push(section)
    }
    return { devDependencies, misplaced: Object.freeze(misplaced) }
}

function misplacedDependencyMessage(sections: readonly string[]): string {
    return `package.json declares ${PACKAGE} in ${sections.join(', ')} outside cockpit-owned devDependencies; cockpit requires one exact development dependency so the team has one version authority. Run npm uninstall ${PACKAGE} && npm install --save-dev --save-exact ${PACKAGE}@${VERSION}, then run npx --no cockpit sync --config <your cockpit.toml> again`
}

function packageCandidate(bytes: string | undefined, verifiedLocalPin?: string): Readonly<{
    bytes: string
    valid: boolean
    misplaced?: readonly string[]
}> {
    let parsed: unknown = {}
    try { parsed = bytes === undefined || bytes.trim() === '' ? {} : JSON.parse(bytes) } catch { return { bytes: '', valid: false } }
    if (!object(parsed)) return { bytes: '', valid: false }
    const slots = packageDependencySlots(parsed)
    const scripts = parsed.scripts === undefined ? {} : parsed.scripts
    if (!slots || !object(scripts)) return { bytes: '', valid: false }
    if (slots.misplaced.length > 0) return { bytes: '', valid: false, misplaced: slots.misplaced }
    const conflictingDependency = slots.devDependencies[PACKAGE] !== undefined && slots.devDependencies[PACKAGE] !== VERSION
        && slots.devDependencies[PACKAGE] !== verifiedLocalPin
    const conflictingScript = Object.entries(SCRIPTS).some(([name, command]) => scripts[name] !== undefined && scripts[name] !== command)
    if (conflictingDependency || conflictingScript) return { bytes: '', valid: false }
    return { valid: true, bytes: `${JSON.stringify({ ...parsed,
        scripts: { ...scripts, ...SCRIPTS }, devDependencies: { ...slots.devDependencies, [PACKAGE]: verifiedLocalPin ?? VERSION },
    }, null, 2)}\n` }
}

// `npm install -D <archive>` pins a `file:` spec, and before a release that archive is the only
// source of the package. The pin is accepted as the team's version when the lockfile resolves it
// to this exact running package; rewriting it to the bare version named a release that may not
// exist and changed a dependency the user chose without asking. The installed copy is compared by
// manifest bytes, not by location: the bootstrap route runs init from a temporary install of the
// same archive, and requiring the running copy to be the root's own install refused that resume.
async function verifiedLocalPin(authority: RootAuthority, packageBytes: string | undefined): Promise<string | undefined> {
    let manifest: unknown
    try { manifest = packageBytes === undefined ? undefined : JSON.parse(packageBytes) } catch { return undefined }
    const dependencies = object(manifest) && object(manifest.devDependencies) ? manifest.devDependencies : undefined
    const spec = dependencies?.[PACKAGE]
    if (typeof spec !== 'string' || !spec.startsWith('file:') || spec.length > 4096) return undefined

    const installedPath = join(authority.root, 'node_modules', ...PACKAGE.split('/'))
    let installed: Awaited<ReturnType<typeof lstat>>
    try { installed = await lstat(installedPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
    }
    if (!installed.isDirectory() || installed.isSymbolicLink()) return undefined
    if (await realpath(installedPath) !== await realpath(INSTALLED_PACKAGE_ROOT)) {
        const installedManifest = await readBoundedInput(join(installedPath, 'package.json'))
        const runningManifest = await readBoundedInput(join(INSTALLED_PACKAGE_ROOT, 'package.json'))
        if (installedManifest.kind !== 'complete' || runningManifest.kind !== 'complete'
            || !Buffer.from(installedManifest.bytes).equals(Buffer.from(runningManifest.bytes))) return undefined
    }

    const lockFile = await readOptional(authority, join(authority.root, 'package-lock.json'))
    if (!lockFile) return undefined
    let lock: unknown
    try { lock = JSON.parse(lockFile.bytes) } catch { return undefined }
    const packages = object(lock) && object(lock.packages) ? lock.packages : undefined
    const rootEntry = packages?.['']
    const rootDependencies = object(rootEntry) && object(rootEntry.devDependencies) ? rootEntry.devDependencies : undefined
    const installedEntry = packages?.[`node_modules/${PACKAGE}`]
    if (!rootDependencies || rootDependencies[PACKAGE] !== spec || !object(installedEntry)
        || installedEntry.version !== VERSION || installedEntry.resolved !== spec) return undefined
    return spec
}

// A checkout is its own Git repository; left visible inside the cockpit root, a `git add` embeds
// it as a gitlink, or fails on one with no commit yet. Cloned rows are repositories by declaration.
// `acquire = "none"` rows are local data the cockpit itself may track, except a directory that
// already holds Git metadata: `sibling add --create` records a new repository as "none" until it
// has a remote, so for those rows the disk decides.
async function ignoreBlock(root: string, config: Pick<CockpitConfig, 'cockpit' | 'sibling' | 'environment'>): Promise<string | undefined> {
    const siblingsRoot = config.cockpit.siblings_root
    if (/[\0\r\n]/.test(siblingsRoot)) return undefined
    const patterns = ['/node_modules/', '/.cockpit/local/', '/env/.secrets/*', '!/env/.secrets/.gitignore']
    const inside = (path: string): string | undefined => {
        const local = relative(root, path)
        if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined
        return `/${local.split(sep).map((part) => part.replace(/[\\*?\[\] !#]/g, '\\$&')).join('/')}/`
    }
    // Generated host paths (browser artifact roots among them) hold run output such as screenshots;
    // left unignored, `git add` commits them.
    for (const generated of config.environment.generated_host_paths) {
        const pattern = inside(resolve(root, generated))
        if (pattern && !patterns.includes(pattern)) patterns.push(pattern)
    }
    const siblings = resolve(root, siblingsRoot)
    const siblingsPattern = inside(siblings)
    if (siblingsPattern) patterns.push(siblingsPattern)
    else for (const sibling of config.sibling) {
        const path = resolve(siblings, sibling.dir)
        const pattern = inside(path)
        if (pattern && !patterns.includes(pattern) && (sibling.acquire !== 'none' || await holdsGitMetadata(path))) patterns.push(pattern)
    }
    const body = patterns.join('\n')
    return `${blockHeader(body)}\n${body}\n${END}`
}

async function holdsGitMetadata(directory: string): Promise<boolean> {
    try {
        await lstat(join(directory, '.git'))
        return true
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return false
        throw error
    }
}

// The start marker carries a digest of the region it opens, which is what separates a region a
// changed configuration made stale (rewritten) from one a person edited (refused). Without it,
// adding a sibling under a siblings_root of "." made every later sync refuse the cockpit's own block.
function blockHeader(body: string): string {
    return `${START} sha256=${createHash('sha256').update(body).digest('hex').slice(0, 16)}`
}

function writtenByCockpit(region: string): boolean {
    const header = region.slice(0, Math.max(0, region.indexOf('\n')))
    const body = region.slice(header.length + 1, region.length - END.length - 1)
    return header !== '' && region.endsWith(`\n${END}`) && header === blockHeader(body)
}

function ignoreCandidate(original: string, block: string): string | undefined {
    const start = original.indexOf(START)
    const end = original.indexOf(END)
    if ((start < 0) !== (end < 0) || start >= 0 && (original.indexOf(START, start + 1) >= 0 || original.indexOf(END, end + 1) >= 0 || end < start)) return undefined
    if (start < 0) return `${original}${original.length > 0 && !original.endsWith('\n') ? '\n' : ''}${block}\n`
    const region = original.slice(start, end + END.length)
    if (region === block) return original
    return writtenByCockpit(region) ? `${original.slice(0, start)}${block}${original.slice(end + END.length)}` : undefined
}

export interface TeamMetadataAuthority {
    readonly changes: readonly TeamMetadataChange[]
}

interface TeamMetadataRecord {
    readonly authority: RootAuthority
    readonly configPath: string
    readonly sourceSha256: string
    readonly files: readonly Readonly<{ path: string; before: Awaited<ReturnType<typeof readOptional>>; bytes: string }>[]
}
const issuedMetadata = new WeakMap<TeamMetadataAuthority, TeamMetadataRecord>()

export async function initializeTeamMetadata(configPath: string, options: Readonly<{ dryRun?: boolean }> = {}): Promise<TeamMetadataResult> {
    const prepared = await prepareTeamMetadata(configPath)
    if (prepared.kind === 'refusal') return prepared
    return options.dryRun ? { kind: 'complete', changed: prepared.authority.changes.length > 0, changes: prepared.authority.changes }
        : applyTeamMetadata(prepared.authority)
}

export async function prepareTeamMetadata(configPath: string): Promise<Extract<TeamMetadataResult, { kind: 'refusal' }>
    | Readonly<{ kind: 'complete'; authority: TeamMetadataAuthority }>> {
    const root = dirname(resolve(configPath))
    try {
        const authority = await captureRoot(root)
        const loaded = await loadCockpitConfig(configPath)
        await authenticateRoot(authority)
        if (loaded.kind !== 'complete') return configRefusal(loaded, configPath)
        const block = await ignoreBlock(root, loaded.result.config)
        if (block === undefined) {
            return refuse('TEAM_METADATA_UNAVAILABLE',
                `cockpit.siblings_root must be a single-line path without NUL because .gitignore cannot represent it literally; fix cockpit.toml and run ${cockpitCommand('sync', { config: configPath })}`,
                'cockpit.siblings_root')
        }
        const packagePath = join(root, 'package.json')
        const packageBefore = await readOptional(authority, packagePath)
        const candidate = packageCandidate(packageBefore?.bytes, await verifiedLocalPin(authority, packageBefore?.bytes))
        if (candidate.misplaced) return refuse('TEAM_METADATA_UNAVAILABLE',
            misplacedDependencyMessage(candidate.misplaced), packagePath)
        if (!candidate.valid) return refuse('TEAM_METADATA_UNAVAILABLE',
            `package.json conflicts with cockpit's exact ${PACKAGE} pin or cockpit:* scripts; resolve the conflict and run ${cockpitCommand('sync', { config: configPath })}`, packagePath)
        const ignorePath = join(root, '.gitignore')
        const ignoreBefore = await readOptional(authority, ignorePath)
        const nextIgnore = ignoreCandidate(ignoreBefore?.bytes ?? '', block)
        if (nextIgnore === undefined) return refuse('TEAM_METADATA_UNAVAILABLE',
            `the cockpit-owned .gitignore block was edited or malformed; restore it exactly, or remove the whole ${START} through ${END} region and run ${cockpitCommand('sync', { config: configPath })}`, ignorePath)
        const files = [
            { path: packagePath, before: packageBefore, bytes: candidate.bytes },
            { path: ignorePath, before: ignoreBefore, bytes: nextIgnore },
        ]
        const changes = Object.freeze(files.filter(file => file.before?.bytes !== file.bytes)
            .map(file => Object.freeze({ operation: 'write' as const, path: relative(root, file.path) })))
        const prepared = Object.freeze({ changes })
        issuedMetadata.set(prepared, { authority, configPath: loaded.result.source.path,
            sourceSha256: loaded.result.source.sha256, files })
        return { kind: 'complete', authority: prepared }
    } catch (error) {
        return refuse('TEAM_METADATA_UNAVAILABLE', `team metadata could not be updated (${error instanceof Error ? error.message : 'unknown I/O error'})`, root)
    }
}

export async function applyTeamMetadata(prepared: TeamMetadataAuthority): Promise<TeamMetadataResult> {
    const record = issuedMetadata.get(prepared)
    if (!record) return refuse('TEAM_METADATA_UNAVAILABLE', 'this team metadata update was already applied or was never prepared; run npx --no cockpit sync --config <your cockpit.toml> again', 'team-metadata')
    issuedMetadata.delete(prepared)
    const { authority, files } = record
    try {
        const loaded = await loadCockpitConfig(record.configPath)
        if (loaded.kind !== 'complete' || loaded.result.source.sha256 !== record.sourceSha256) throw new Error('configuration changed before metadata replacement')
        await authenticateRoot(authority)
        for (const file of files) {
            if ((await readOptional(authority, file.path))?.identity !== file.before?.identity) throw new Error('team metadata changed before replacement')
        }
        for (const file of files) if (file.before?.bytes !== file.bytes) await replaceAuthenticated(authority, file.path, file.before, file.bytes)
        return { kind: 'complete', changed: prepared.changes.length > 0, changes: prepared.changes }
    } catch (error) {
        return refuse('TEAM_METADATA_UNAVAILABLE', `team metadata could not be updated (${error instanceof Error ? error.message : 'unknown I/O error'})`, authority.root)
    }
}

export async function validateTeamMetadata(configPath: string): Promise<TeamMetadataResult> {
    const root = dirname(resolve(configPath))
    const packagePath = join(root, 'package.json')
    try {
        const authority = await captureRoot(root)
        const current = await readOptional(authority, packagePath)
        let parsed: unknown
        try { parsed = current ? JSON.parse(current.bytes) : undefined } catch { parsed = undefined }
        const slots = object(parsed) ? packageDependencySlots(parsed) : undefined
        if (object(parsed) && !slots) return refuse('TEAM_METADATA_UNAVAILABLE',
            'package.json direct npm dependency sections must be objects; repair package.json, then run npx --no cockpit sync --config <your cockpit.toml> again', packagePath)
        if (slots?.misplaced.length) return refuse('TEAM_METADATA_UNAVAILABLE',
            misplacedDependencyMessage(slots.misplaced), packagePath)
        const pinned = slots?.devDependencies[PACKAGE]
        if (typeof pinned === 'string' && pinned.startsWith('file:')) {
            if (pinned !== await verifiedLocalPin(authority, current?.bytes)) return refuse('COCKPIT_VERSION_MISMATCH',
                `package.json pins ${PACKAGE} to ${pinned}, but package-lock.json and node_modules do not resolve that archive to the running ${VERSION}; run npm install, then ${cockpitCommand('check')}`, packagePath)
        } else if (pinned !== VERSION) return refuse('COCKPIT_VERSION_MISMATCH',
            `package.json pins ${PACKAGE} ${String(pinned ?? '(missing)')}, but ${VERSION} is running; run npm install --save-dev --save-exact ${PACKAGE}@${VERSION}`, packagePath)
        const scripts = object(parsed) && object(parsed.scripts) ? parsed.scripts : undefined
        if (!scripts || Object.entries(SCRIPTS).some(([name, command]) => scripts[name] !== command)) {
            return refuse('TEAM_METADATA_UNAVAILABLE', `package.json does not contain the exact cockpit:* scripts that sync writes; run ${cockpitCommand('sync', { config: configPath })}`, packagePath)
        }
        const loaded = await loadCockpitConfig(configPath)
        await authenticateRoot(authority)
        if (loaded.kind !== 'complete') return configRefusal(loaded, configPath)
        const block = await ignoreBlock(root, loaded.result.config)
        if (block === undefined) {
            return refuse('TEAM_METADATA_UNAVAILABLE',
                `cockpit.siblings_root must be a single-line path without NUL because .gitignore cannot represent it literally; fix cockpit.toml and run ${cockpitCommand('sync', { config: configPath })}`,
                'cockpit.siblings_root')
        }
        const ignorePath = join(root, '.gitignore')
        const ignore = await readOptional(authority, ignorePath)
        const expected = ignoreCandidate(ignore?.bytes ?? '', block)
        if (expected === undefined) return refuse('TEAM_METADATA_UNAVAILABLE',
            `the cockpit-owned .gitignore block was edited; restore it exactly, or remove the whole ${START} through ${END} region and run npx --no cockpit sync --config <your cockpit.toml> again`, ignorePath)
        if (!ignore || expected !== ignore.bytes) return refuse('TEAM_METADATA_UNAVAILABLE',
            'the cockpit-owned .gitignore block is missing or does not match cockpit.toml and the sibling directories on disk; run npx --no cockpit sync --config <your cockpit.toml> to rewrite it', ignorePath)
        return { kind: 'complete', changed: false, changes: Object.freeze([]) }
    } catch (error) {
        return refuse('TEAM_METADATA_UNAVAILABLE', `team metadata could not be verified (${error instanceof Error ? error.message : 'unknown I/O error'})`, root)
    }
}
