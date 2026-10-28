import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { loadCockpitConfig, readBoundedInput } from './config/load.js'
import { ENVIRONMENT_CODES } from './environment/contract.js'
import { installedPackageMetadata } from './package-metadata.js'

export const mechanism = {
    id: 'team-metadata', module: 'packages/cockpit/src/team-metadata.ts',
    exports: ['ensureTeamMetadata', 'validateTeamMetadata'],
} as const

const PACKAGE = installedPackageMetadata.name
const VERSION = installedPackageMetadata.version
const SCRIPTS = Object.freeze({
    'cockpit:setup': 'cockpit setup --config cockpit.toml',
    'cockpit:sync': 'cockpit sync --config cockpit.toml',
    'cockpit:check': 'cockpit check --config cockpit.toml',
})
const START = '# cockpit:ignore:start'
const END = '# cockpit:ignore:end'

export type TeamMetadataResult = Readonly<{ kind: 'complete'; changed: boolean }>
    | Readonly<{ kind: 'refusal'; code: typeof ENVIRONMENT_CODES.TEAM_METADATA_UNAVAILABLE | typeof ENVIRONMENT_CODES.COCKPIT_VERSION_MISMATCH; message: string; target: string }>

function refuse(code: typeof ENVIRONMENT_CODES.TEAM_METADATA_UNAVAILABLE | typeof ENVIRONMENT_CODES.COCKPIT_VERSION_MISMATCH,
    message: string, target: string): TeamMetadataResult {
    return { kind: 'refusal', code, message, target }
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readOptional(path: string): Promise<Readonly<{ bytes: string; mode: number; identity: string }> | undefined> {
    try {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file')
        const read = await readBoundedInput(path)
        if (read.kind !== 'complete') throw new Error('file exceeds the input limit')
        return { bytes: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes), mode: stat.mode,
            identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(read.bytes).digest('hex')}` }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
    }
}

async function replaceAuthenticated(path: string, before: Awaited<ReturnType<typeof readOptional>>, bytes: string): Promise<void> {
    const directory = dirname(path)
    const temporary = join(directory, `.${path.slice(path.lastIndexOf('/') + 1)}.cockpit-${randomBytes(8).toString('hex')}`)
    let created = false
    try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            before?.mode ?? 0o644)
        created = true
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        const current = await readOptional(path)
        if (current?.identity !== before?.identity) throw new Error('file changed before replacement')
        await rename(temporary, path)
        created = false
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await parent.sync() } finally { await parent.close() }
    } finally {
        if (created) await unlink(temporary)
    }
}

function packageCandidate(bytes: string | undefined): Readonly<{ bytes: string; valid: boolean }> {
    let parsed: unknown = {}
    try { parsed = bytes === undefined || bytes.trim() === '' ? {} : JSON.parse(bytes) } catch { return { bytes: '', valid: false } }
    if (!object(parsed)) return { bytes: '', valid: false }
    const dependencies = parsed.devDependencies === undefined ? {} : parsed.devDependencies
    const scripts = parsed.scripts === undefined ? {} : parsed.scripts
    if (!object(dependencies) || !object(scripts)) return { bytes: '', valid: false }
    const conflictingDependency = dependencies[PACKAGE] !== undefined && dependencies[PACKAGE] !== VERSION
    const conflictingScript = Object.entries(SCRIPTS).some(([name, command]) => scripts[name] !== undefined && scripts[name] !== command)
    if (conflictingDependency || conflictingScript) return { bytes: '', valid: false }
    return { valid: true, bytes: `${JSON.stringify({ ...parsed,
        scripts: { ...scripts, ...SCRIPTS }, devDependencies: { ...dependencies, [PACKAGE]: VERSION },
    }, null, 2)}\n` }
}

function ignoreBlock(root: string, siblingsRoot: string): string {
    const patterns = ['/.cockpit/local/', '/env/.secrets/*', '!/env/.secrets/.gitignore']
    const siblings = resolve(root, siblingsRoot)
    const local = relative(root, siblings)
    if (local !== '' && !local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && local !== '..' && !isAbsolute(local)) {
        patterns.push(`/${local.replaceAll('\\', '/')}/`)
    }
    return [START, ...patterns, END].join('\n')
}

function replaceIgnoreRegion(original: string, block: string): string | undefined {
    const start = original.indexOf(START)
    const end = original.indexOf(END)
    if ((start < 0) !== (end < 0) || start >= 0 && (original.indexOf(START, start + 1) >= 0 || original.indexOf(END, end + 1) >= 0 || end < start)) return undefined
    if (start < 0) return `${original}${original.length > 0 && !original.endsWith('\n') ? '\n' : ''}${block}\n`
    return `${original.slice(0, start)}${block}${original.slice(end + END.length)}`
}

export async function ensureTeamMetadata(configPath: string): Promise<TeamMetadataResult> {
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete') return refuse('TEAM_METADATA_UNAVAILABLE', 'cockpit.toml must be valid before team metadata can be written', configPath)
    const root = dirname(resolve(configPath))
    try {
        const packagePath = join(root, 'package.json')
        const packageBefore = await readOptional(packagePath)
        const candidate = packageCandidate(packageBefore?.bytes)
        if (!candidate.valid) return refuse('TEAM_METADATA_UNAVAILABLE',
            `package.json conflicts with cockpit's exact ${PACKAGE} pin or cockpit:* scripts; resolve the conflict and run cockpit init again`, packagePath)
        const ignorePath = join(root, '.gitignore')
        const ignoreBefore = await readOptional(ignorePath)
        const block = ignoreBlock(root, loaded.result.config.cockpit.siblings_root)
        const ignoreCandidate = replaceIgnoreRegion(ignoreBefore?.bytes ?? '', block)
        if (ignoreCandidate === undefined) return refuse('TEAM_METADATA_UNAVAILABLE',
            `${START} and ${END} must appear once, in order`, ignorePath)
        let changed = false
        if (packageBefore?.bytes !== candidate.bytes) { await replaceAuthenticated(packagePath, packageBefore, candidate.bytes); changed = true }
        if (ignoreBefore?.bytes !== ignoreCandidate) { await replaceAuthenticated(ignorePath, ignoreBefore, ignoreCandidate); changed = true }
        return { kind: 'complete', changed }
    } catch (error) {
        return refuse('TEAM_METADATA_UNAVAILABLE', `team metadata could not be updated (${error instanceof Error ? error.message : 'unknown I/O error'})`, root)
    }
}

export async function validateTeamMetadata(configPath: string): Promise<TeamMetadataResult> {
    const root = dirname(resolve(configPath))
    const packagePath = join(root, 'package.json')
    try {
        const current = await readOptional(packagePath)
        let parsed: unknown
        try { parsed = current ? JSON.parse(current.bytes) : undefined } catch { parsed = undefined }
        const pinned = object(parsed) && object(parsed.devDependencies) ? parsed.devDependencies[PACKAGE] : undefined
        if (pinned !== VERSION) return refuse('COCKPIT_VERSION_MISMATCH',
            `package.json pins ${PACKAGE} ${String(pinned ?? '(missing)')}, but ${VERSION} is running; run npm install --save-dev --save-exact ${PACKAGE}@${VERSION}`, packagePath)
        const scripts = object(parsed) && object(parsed.scripts) ? parsed.scripts : undefined
        if (!scripts || Object.entries(SCRIPTS).some(([name, command]) => scripts[name] !== command)) {
            return refuse('TEAM_METADATA_UNAVAILABLE', 'package.json does not contain the exact cockpit:* scripts written by cockpit init; run cockpit init again', packagePath)
        }
        const loaded = await loadCockpitConfig(configPath)
        if (loaded.kind !== 'complete') return refuse('TEAM_METADATA_UNAVAILABLE', 'cockpit.toml is invalid', configPath)
        const ignorePath = join(root, '.gitignore')
        const ignore = await readOptional(ignorePath)
        const expected = replaceIgnoreRegion(ignore?.bytes ?? '', ignoreBlock(root, loaded.result.config.cockpit.siblings_root))
        if (!ignore || expected === undefined || expected !== ignore.bytes) return refuse('TEAM_METADATA_UNAVAILABLE',
            'the cockpit-owned .gitignore block is missing or stale; run cockpit sync', ignorePath)
        return { kind: 'complete', changed: false }
    } catch (error) {
        return refuse('TEAM_METADATA_UNAVAILABLE', `package.json could not be authenticated (${error instanceof Error ? error.message : 'unknown I/O error'})`, packagePath)
    }
}
