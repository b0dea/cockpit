import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCockpitConfig, readBoundedInput } from './config/load.js'
import { ENVIRONMENT_CODES, type EnvironmentDiagnostic } from './environment/contract.js'
import type { CockpitConfig } from './schema.js'
import { installedPackageMetadata } from './package-metadata.js'

export const mechanism = {
    id: 'team-metadata', module: 'packages/cockpit/src/team-metadata.ts',
    exports: ['initializeTeamMetadata', 'prepareTeamMetadata', 'applyTeamMetadata', 'validateTeamMetadata'],
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
    return `package.json declares ${PACKAGE} in ${sections.join(', ')} outside cockpit-owned devDependencies; cockpit requires one exact development dependency so the team has one version authority. Run npm uninstall ${PACKAGE} && npm install --save-dev --save-exact ${PACKAGE}@${VERSION}, then run cockpit sync again`
}

function packageCandidate(bytes: string | undefined, authenticatedSourceSpec?: string): Readonly<{
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
        && slots.devDependencies[PACKAGE] !== authenticatedSourceSpec
    const conflictingScript = Object.entries(SCRIPTS).some(([name, command]) => scripts[name] !== undefined && scripts[name] !== command)
    if (conflictingDependency || conflictingScript) return { bytes: '', valid: false }
    return { valid: true, bytes: `${JSON.stringify({ ...parsed,
        scripts: { ...scripts, ...SCRIPTS }, devDependencies: { ...slots.devDependencies, [PACKAGE]: VERSION },
    }, null, 2)}\n` }
}

interface SourceInstallCandidate {
    readonly before: NonNullable<Awaited<ReturnType<typeof readOptional>>>
    readonly bytes: string
    readonly spec: string
    readonly installedPath: string
    readonly installedDev: number
    readonly installedIno: number
}

async function sourceInstallCandidate(authority: RootAuthority, packageBytes: string | undefined): Promise<SourceInstallCandidate | undefined> {
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
    if (!installed.isDirectory() || installed.isSymbolicLink()
        || await realpath(installedPath) !== await realpath(INSTALLED_PACKAGE_ROOT)) return undefined

    const lockPath = join(authority.root, 'package-lock.json')
    const before = await readOptional(authority, lockPath)
    if (!before) return undefined
    let lock: unknown
    try { lock = JSON.parse(before.bytes) } catch { return undefined }
    const lockRecord = object(lock) ? lock : undefined
    const packages = lockRecord && object(lockRecord.packages) ? lockRecord.packages : undefined
    const rootValue = packages?.['']
    const rootEntry = object(rootValue) ? rootValue : undefined
    const rootDependencies = rootEntry && object(rootEntry.devDependencies) ? rootEntry.devDependencies : undefined
    const installedValue = packages?.[`node_modules/${PACKAGE}`]
    const installedEntry = object(installedValue) ? installedValue : undefined
    if (!packages || !rootEntry || !rootDependencies || !installedEntry
        || (rootDependencies[PACKAGE] !== spec && rootDependencies[PACKAGE] !== VERSION)
        || installedEntry.version !== VERSION || installedEntry.resolved !== spec) return undefined
    const bytes = `${JSON.stringify({ ...lockRecord, packages: { ...packages, '': {
        ...rootEntry, devDependencies: { ...rootDependencies, [PACKAGE]: VERSION },
    } } }, null, 2)}\n`
    return { before, bytes, spec, installedPath, installedDev: installed.dev, installedIno: installed.ino }
}

async function authenticateSourceInstall(candidate: SourceInstallCandidate): Promise<void> {
    const current = await lstat(candidate.installedPath)
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== candidate.installedDev || current.ino !== candidate.installedIno
        || await realpath(candidate.installedPath) !== await realpath(INSTALLED_PACKAGE_ROOT)) {
        throw new Error('installed cockpit package changed before metadata replacement')
    }
}

// A checkout cockpit clones is its own Git repository; left visible inside the cockpit root, a
// `git add` embeds it as a gitlink. `acquire = "none"` rows are local data, never repositories,
// and may be tracked by the cockpit itself, so they stay visible.
function ignoreBlock(root: string, config: Pick<CockpitConfig, 'cockpit' | 'sibling'>): string | undefined {
    const siblingsRoot = config.cockpit.siblings_root
    if (/[\0\r\n]/.test(siblingsRoot)) return undefined
    const patterns = ['/node_modules/', '/.cockpit/local/', '/env/.secrets/*', '!/env/.secrets/.gitignore']
    const inside = (path: string): string | undefined => {
        const local = relative(root, path)
        if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined
        return `/${local.split(sep).map((part) => part.replace(/[\\*?\[\] !#]/g, '\\$&')).join('/')}/`
    }
    const siblings = resolve(root, siblingsRoot)
    const siblingsPattern = inside(siblings)
    if (siblingsPattern) patterns.push(siblingsPattern)
    else for (const sibling of config.sibling) {
        const pattern = sibling.acquire === 'none' ? undefined : inside(resolve(siblings, sibling.dir))
        if (pattern && !patterns.includes(pattern)) patterns.push(pattern)
    }
    return [START, ...patterns, END].join('\n')
}

function ignoreCandidate(original: string, block: string): string | undefined {
    const start = original.indexOf(START)
    const end = original.indexOf(END)
    if ((start < 0) !== (end < 0) || start >= 0 && (original.indexOf(START, start + 1) >= 0 || original.indexOf(END, end + 1) >= 0 || end < start)) return undefined
    if (start < 0) return `${original}${original.length > 0 && !original.endsWith('\n') ? '\n' : ''}${block}\n`
    return original.slice(start, end + END.length) === block ? original : undefined
}

export interface TeamMetadataAuthority {
    readonly changes: readonly TeamMetadataChange[]
}

interface TeamMetadataRecord {
    readonly authority: RootAuthority
    readonly configPath: string
    readonly sourceSha256: string
    readonly sourceInstall: SourceInstallCandidate | undefined
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
        const block = ignoreBlock(root, loaded.result.config)
        if (block === undefined) {
            return refuse('TEAM_METADATA_UNAVAILABLE',
                'cockpit.siblings_root must be a single-line path without NUL because .gitignore cannot represent it literally; fix cockpit.toml and run cockpit init again',
                'cockpit.siblings_root')
        }
        const packagePath = join(root, 'package.json')
        const packageBefore = await readOptional(authority, packagePath)
        const sourceInstall = await sourceInstallCandidate(authority, packageBefore?.bytes)
        const candidate = packageCandidate(packageBefore?.bytes, sourceInstall?.spec)
        if (candidate.misplaced) return refuse('TEAM_METADATA_UNAVAILABLE',
            misplacedDependencyMessage(candidate.misplaced), packagePath)
        if (!candidate.valid) return refuse('TEAM_METADATA_UNAVAILABLE',
            `package.json conflicts with cockpit's exact ${PACKAGE} pin or cockpit:* scripts; resolve the conflict and run cockpit init again`, packagePath)
        const ignorePath = join(root, '.gitignore')
        const ignoreBefore = await readOptional(authority, ignorePath)
        const nextIgnore = ignoreCandidate(ignoreBefore?.bytes ?? '', block)
        if (nextIgnore === undefined) return refuse('TEAM_METADATA_UNAVAILABLE',
            `the cockpit-owned .gitignore block was edited or malformed; restore it exactly, or remove the whole ${START} through ${END} region and run cockpit init again`, ignorePath)
        const files = [
            ...(sourceInstall ? [{ path: join(root, 'package-lock.json'), before: sourceInstall.before, bytes: sourceInstall.bytes }] : []),
            { path: packagePath, before: packageBefore, bytes: candidate.bytes },
            { path: ignorePath, before: ignoreBefore, bytes: nextIgnore },
        ]
        const changes = Object.freeze(files.filter(file => file.before?.bytes !== file.bytes)
            .map(file => Object.freeze({ operation: 'write' as const, path: relative(root, file.path) })))
        const prepared = Object.freeze({ changes })
        issuedMetadata.set(prepared, { authority, configPath: loaded.result.source.path,
            sourceSha256: loaded.result.source.sha256, sourceInstall, files })
        return { kind: 'complete', authority: prepared }
    } catch (error) {
        return refuse('TEAM_METADATA_UNAVAILABLE', `team metadata could not be updated (${error instanceof Error ? error.message : 'unknown I/O error'})`, root)
    }
}

export async function applyTeamMetadata(prepared: TeamMetadataAuthority): Promise<TeamMetadataResult> {
    const record = issuedMetadata.get(prepared)
    if (!record) return refuse('TEAM_METADATA_UNAVAILABLE', 'this team metadata update was already applied or was never prepared; run cockpit sync again', 'team-metadata')
    issuedMetadata.delete(prepared)
    const { authority, sourceInstall, files } = record
    try {
        const loaded = await loadCockpitConfig(record.configPath)
        if (loaded.kind !== 'complete' || loaded.result.source.sha256 !== record.sourceSha256) throw new Error('configuration changed before metadata replacement')
        await authenticateRoot(authority)
        for (const file of files) {
            if ((await readOptional(authority, file.path))?.identity !== file.before?.identity) throw new Error('team metadata changed before replacement')
        }
        if (sourceInstall) await authenticateSourceInstall(sourceInstall)
        for (const file of files) if (file.before?.bytes !== file.bytes) {
            if (sourceInstall) await authenticateSourceInstall(sourceInstall)
            await replaceAuthenticated(authority, file.path, file.before, file.bytes)
        }
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
            'package.json direct npm dependency sections must be objects; repair package.json, then run cockpit sync again', packagePath)
        if (slots?.misplaced.length) return refuse('TEAM_METADATA_UNAVAILABLE',
            misplacedDependencyMessage(slots.misplaced), packagePath)
        const pinned = slots?.devDependencies[PACKAGE]
        if (pinned !== VERSION) return refuse('COCKPIT_VERSION_MISMATCH',
            `package.json pins ${PACKAGE} ${String(pinned ?? '(missing)')}, but ${VERSION} is running; run npm install --save-dev --save-exact ${PACKAGE}@${VERSION}`, packagePath)
        const scripts = object(parsed) && object(parsed.scripts) ? parsed.scripts : undefined
        if (!scripts || Object.entries(SCRIPTS).some(([name, command]) => scripts[name] !== command)) {
            return refuse('TEAM_METADATA_UNAVAILABLE', 'package.json does not contain the exact cockpit:* scripts written by cockpit init; run cockpit init again', packagePath)
        }
        const loaded = await loadCockpitConfig(configPath)
        await authenticateRoot(authority)
        if (loaded.kind !== 'complete') return configRefusal(loaded, configPath)
        const block = ignoreBlock(root, loaded.result.config)
        if (block === undefined) {
            return refuse('TEAM_METADATA_UNAVAILABLE',
                'cockpit.siblings_root must be a single-line path without NUL because .gitignore cannot represent it literally; fix cockpit.toml and run cockpit init again',
                'cockpit.siblings_root')
        }
        const ignorePath = join(root, '.gitignore')
        const ignore = await readOptional(authority, ignorePath)
        const expected = ignoreCandidate(ignore?.bytes ?? '', block)
        if (!ignore || expected === undefined || expected !== ignore.bytes) return refuse('TEAM_METADATA_UNAVAILABLE',
            `the cockpit-owned .gitignore block is missing, stale or edited; restore it exactly, or remove the whole ${START} through ${END} region and run cockpit init again`, ignorePath)
        return { kind: 'complete', changed: false, changes: Object.freeze([]) }
    } catch (error) {
        return refuse('TEAM_METADATA_UNAVAILABLE', `team metadata could not be verified (${error instanceof Error ? error.message : 'unknown I/O error'})`, root)
    }
}
