import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { loadCockpitConfig, readBoundedInput } from './config/load.js'
import { ENVIRONMENT_CODES } from './environment/contract.js'
import { installedPackageMetadata } from './package-metadata.js'

export const mechanism = {
    id: 'team-metadata', module: 'packages/cockpit/src/team-metadata.ts',
    exports: ['initializeTeamMetadata', 'validateTeamMetadata'],
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
    const patterns = ['/node_modules/', '/.cockpit/local/', '/env/.secrets/*', '!/env/.secrets/.gitignore']
    const siblings = resolve(root, siblingsRoot)
    const local = relative(root, siblings)
    if (local !== '' && !local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && local !== '..' && !isAbsolute(local)) {
        patterns.push(`/${local.replaceAll('\\', '/')}/`)
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

export async function initializeTeamMetadata(configPath: string): Promise<TeamMetadataResult> {
    const root = dirname(resolve(configPath))
    try {
        const authority = await captureRoot(root)
        const loaded = await loadCockpitConfig(configPath)
        await authenticateRoot(authority)
        if (loaded.kind !== 'complete') return refuse('TEAM_METADATA_UNAVAILABLE', 'cockpit.toml must be valid before team metadata can be written', configPath)
        const packagePath = join(root, 'package.json')
        const packageBefore = await readOptional(authority, packagePath)
        const candidate = packageCandidate(packageBefore?.bytes)
        if (!candidate.valid) return refuse('TEAM_METADATA_UNAVAILABLE',
            `package.json conflicts with cockpit's exact ${PACKAGE} pin or cockpit:* scripts; resolve the conflict and run cockpit init again`, packagePath)
        const ignorePath = join(root, '.gitignore')
        const ignoreBefore = await readOptional(authority, ignorePath)
        const block = ignoreBlock(root, loaded.result.config.cockpit.siblings_root)
        const nextIgnore = ignoreCandidate(ignoreBefore?.bytes ?? '', block)
        if (nextIgnore === undefined) return refuse('TEAM_METADATA_UNAVAILABLE',
            `the cockpit-owned .gitignore block was edited or malformed; restore it exactly, or remove the whole ${START} through ${END} region and run cockpit init again`, ignorePath)
        let changed = false
        if (packageBefore?.bytes !== candidate.bytes) { await replaceAuthenticated(authority, packagePath, packageBefore, candidate.bytes); changed = true }
        if (ignoreBefore?.bytes !== nextIgnore) { await replaceAuthenticated(authority, ignorePath, ignoreBefore, nextIgnore); changed = true }
        return { kind: 'complete', changed }
    } catch (error) {
        return refuse('TEAM_METADATA_UNAVAILABLE', `team metadata could not be updated (${error instanceof Error ? error.message : 'unknown I/O error'})`, root)
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
        const pinned = object(parsed) && object(parsed.devDependencies) ? parsed.devDependencies[PACKAGE] : undefined
        if (pinned !== VERSION) return refuse('COCKPIT_VERSION_MISMATCH',
            `package.json pins ${PACKAGE} ${String(pinned ?? '(missing)')}, but ${VERSION} is running; run npm install --save-dev --save-exact ${PACKAGE}@${VERSION}`, packagePath)
        const scripts = object(parsed) && object(parsed.scripts) ? parsed.scripts : undefined
        if (!scripts || Object.entries(SCRIPTS).some(([name, command]) => scripts[name] !== command)) {
            return refuse('TEAM_METADATA_UNAVAILABLE', 'package.json does not contain the exact cockpit:* scripts written by cockpit init; run cockpit init again', packagePath)
        }
        const loaded = await loadCockpitConfig(configPath)
        await authenticateRoot(authority)
        if (loaded.kind !== 'complete') return refuse('TEAM_METADATA_UNAVAILABLE', 'cockpit.toml is invalid', configPath)
        const ignorePath = join(root, '.gitignore')
        const ignore = await readOptional(authority, ignorePath)
        const expected = ignoreCandidate(ignore?.bytes ?? '', ignoreBlock(root, loaded.result.config.cockpit.siblings_root))
        if (!ignore || expected === undefined || expected !== ignore.bytes) return refuse('TEAM_METADATA_UNAVAILABLE',
            `the cockpit-owned .gitignore block is missing, stale or edited; restore it exactly, or remove the whole ${START} through ${END} region and run cockpit init again`, ignorePath)
        return { kind: 'complete', changed: false }
    } catch (error) {
        return refuse('TEAM_METADATA_UNAVAILABLE', `team metadata could not be authenticated (${error instanceof Error ? error.message : 'unknown I/O error'})`, root)
    }
}
