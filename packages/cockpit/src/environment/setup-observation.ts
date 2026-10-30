import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import { EnvironmentFile, type EnvironmentFile as EnvironmentFileValue } from '../schema.js'
import { loadCockpitConfig } from '../config/load.js'
import { cockpitCommand, formatShellCommand } from '../fix-catalogue.js'
import { authenticatedExecutionOutcome, executeProbe } from '../environment-exec/execute.js'
import {
    ENVIRONMENT_CODES,
    isCanonicalTimestamp,
    snapshotJson,
    type CheckoutId,
    type CockpitId,
    type ExecutionStep,
    type FilesystemCheck,
    type RefusalCode,
    type SourceProvenance,
} from './contract.js'
import type { SetupObservation, SetupPathEvidence } from './setup.js'
import { gitEnvironment } from './setup.js'
import { resolveGitExecutable, resolvedGitExecutable, type ResolvedExecutable } from './executable.js'
import { checkoutId as deriveCheckoutId } from './identity.js'
import { cockpitId as deriveCockpitId } from './identity.js'

export const mechanism = {
    id: 'setup-observation',
    module: 'packages/cockpit/src/environment/setup-observation.ts',
    exports: [
        'observeSetupPath',
        'observeSetupCheckout',
        'withSetupCheckoutProjection',
        'consumeSetupCheckoutProjection',
        'observeGeneratedCheckoutIdentity',
        'revalidateGeneratedCheckoutIdentity',
        'observeEnvironmentIgnore',
    ],
} as const

const CHECKOUT_ID = /^checkout:[a-f0-9]{64}$/
const SLUG = /^[a-z0-9][a-z0-9-]*$/
const SHA256 = /^[a-f0-9]{64}$/
const IGNORE_OBSERVATION_LIFETIME_MS = 60_000
const SETUP_CHECKOUT_OBSERVATION_LIFETIME_MS = 60_000
const CONFIGURATION_BYTE_LIMIT = 1_048_576
const COCKPIT_NAME = /^[a-z0-9][a-z0-9-]*$/

interface DirectoryIdentity {
    readonly dev: string
    readonly ino: string
    readonly mode: string
    readonly mtimeNs: string
    readonly ctimeNs: string
}

interface FileIdentity extends DirectoryIdentity {
    readonly size: string
    readonly nlink: string
}

interface StableFile {
    readonly identity: FileIdentity
    readonly sha256: string
    readonly byteLength: number
}

type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
    try {
        return typeof Reflect.get(value, 'then') === 'function'
    } catch {
        return true
    }
}

function directoryIdentity(stat: BigIntStats): DirectoryIdentity {
    return Object.freeze({
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: stat.mode.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
    })
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
        && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function sameDirectoryNode(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

async function resolvedDirectory(path: string): Promise<{
    canonicalPath: string
    beforeIdentity: DirectoryIdentity
    afterIdentity: DirectoryIdentity
} | undefined> {
    try {
        const before = await lstat(path, { bigint: true })
        if (!before.isDirectory() || before.isSymbolicLink()) return undefined
        const canonicalPath = await realpath(path)
        const after = await lstat(canonicalPath, { bigint: true })
        if (canonicalPath !== path || !after.isDirectory() || after.isSymbolicLink()) return undefined
        return Object.freeze({ canonicalPath, beforeIdentity: directoryIdentity(before), afterIdentity: directoryIdentity(after) })
    } catch {
        return undefined
    }
}

async function stableDirectory(path: string): Promise<{ canonicalPath: string; identity: DirectoryIdentity } | undefined> {
    const resolved = await resolvedDirectory(path)
    return resolved && sameDirectoryIdentity(resolved.beforeIdentity, resolved.afterIdentity)
        ? Object.freeze({ canonicalPath: resolved.canonicalPath, identity: resolved.afterIdentity })
        : undefined
}

async function stableDirectoryNode(path: string): Promise<{ canonicalPath: string; identity: DirectoryIdentity } | undefined> {
    const resolved = await resolvedDirectory(path)
    return resolved && sameDirectoryNode(resolved.beforeIdentity, resolved.afterIdentity)
        ? Object.freeze({ canonicalPath: resolved.canonicalPath, identity: resolved.afterIdentity })
        : undefined
}

function fileIdentity(stat: BigIntStats): FileIdentity {
    return Object.freeze({ ...directoryIdentity(stat), size: stat.size.toString(), nlink: stat.nlink.toString() })
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return sameDirectoryIdentity(left, right) && left.size === right.size && left.nlink === right.nlink
}

async function stableFile(path: string): Promise<StableFile | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        const before = await lstat(path, { bigint: true })
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
            || before.size > BigInt(CONFIGURATION_BYTE_LIMIT)) return undefined
        if (await realpath(path) !== path) return undefined
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await handle.stat({ bigint: true })
        const beforeIdentity = fileIdentity(before)
        const openedIdentity = fileIdentity(opened)
        if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(beforeIdentity, openedIdentity)) return undefined
        const bytes = await handle.readFile()
        const after = await handle.stat({ bigint: true })
        const linked = await lstat(path, { bigint: true })
        const afterIdentity = fileIdentity(after)
        const linkedIdentity = fileIdentity(linked)
        if (after.nlink !== 1n || linked.nlink !== 1n || bytes.length !== Number(opened.size)
            || !sameFileIdentity(openedIdentity, afterIdentity)
            || !sameFileIdentity(openedIdentity, linkedIdentity)) return undefined
        return Object.freeze({
            identity: openedIdentity,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            byteLength: bytes.length,
        })
    } catch {
        return undefined
    } finally {
        try { await handle?.close() } catch { /* Unavailable evidence carries no file authority. */ }
    }
}

function validSource(value: unknown): value is SourceProvenance {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const source = value as Record<string, unknown>
    return typeof source.path === 'string' && isAbsolute(source.path) && resolve(source.path) === source.path
        && !source.path.includes('\0') && Number.isSafeInteger(source.byteLength) && (source.byteLength as number) >= 0
        && typeof source.sha256 === 'string' && SHA256.test(source.sha256)
}

interface EnvironmentIgnoreInput {
    readonly source: SourceProvenance
    readonly siblingIndex: number
    readonly siblingSlug: string
    readonly mainCheckoutPath: string
    readonly siblingsRoot: string
    readonly siblingRoot: string
    readonly checkoutId: CheckoutId
    readonly environmentFileIndex: number
    readonly environmentFile: EnvironmentFileValue
    readonly observedAt: string
    readonly env: Readonly<Record<string, string>>
    readonly gitExecutable: ResolvedExecutable
}

export type EnvironmentIgnoreRefusal = Readonly<{
    kind: 'refusal'
    code:
        | typeof ENVIRONMENT_CODES.INSTANCE_NOT_IGNORED
        | typeof ENVIRONMENT_CODES.TEMPLATE_NOT_TRACKED
        | typeof ENVIRONMENT_CODES.TEMPLATE_IGNORED
    path: string
}>

function snapshotIgnoreInput(value: unknown): EnvironmentIgnoreInput | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const input = snapshot as Record<string, unknown>
    const expectedKeys = [
        'checkoutId', 'env', 'environmentFile', 'environmentFileIndex', 'gitExecutable', 'mainCheckoutPath', 'observedAt', 'siblingIndex', 'siblingRoot',
        'siblingSlug', 'siblingsRoot', 'source',
    ]
    const environmentFile = EnvironmentFile.safeParse(input.environmentFile)
    const executable = resolvedGitExecutable(input.gitExecutable)
    const environment = input.env
    if (Object.keys(input).sort().join('\0') !== expectedKeys.join('\0')
        || !validSource(input.source)
        || !Number.isSafeInteger(input.siblingIndex) || (input.siblingIndex as number) < 0
        || typeof input.siblingSlug !== 'string' || !SLUG.test(input.siblingSlug)
        || typeof input.mainCheckoutPath !== 'string' || !isAbsolute(input.mainCheckoutPath)
        || resolve(input.mainCheckoutPath) !== input.mainCheckoutPath || input.mainCheckoutPath.includes('\0')
        || typeof input.siblingsRoot !== 'string' || !isAbsolute(input.siblingsRoot)
        || resolve(input.siblingsRoot) !== input.siblingsRoot || input.siblingsRoot.includes('\0')
        || typeof input.siblingRoot !== 'string' || !isAbsolute(input.siblingRoot)
        || resolve(input.siblingRoot) !== input.siblingRoot || input.siblingRoot.includes('\0')
        || typeof input.checkoutId !== 'string' || !CHECKOUT_ID.test(input.checkoutId)
        || !Number.isSafeInteger(input.environmentFileIndex) || (input.environmentFileIndex as number) < 0
        || !environmentFile.success || !isCanonicalTimestamp(input.observedAt) || executable === undefined
        || environment === null || typeof environment !== 'object' || Array.isArray(environment)
        || Object.values(environment).some((entry) => typeof entry !== 'string')) return undefined
    return Object.freeze({
        source: Object.freeze({ ...input.source }),
        siblingIndex: input.siblingIndex as number,
        siblingSlug: input.siblingSlug,
        mainCheckoutPath: input.mainCheckoutPath,
        siblingsRoot: input.siblingsRoot,
        siblingRoot: input.siblingRoot,
        checkoutId: input.checkoutId as CheckoutId,
        environmentFileIndex: input.environmentFileIndex as number,
        environmentFile: Object.freeze({ ...environmentFile.data }),
        observedAt: input.observedAt,
        env: Object.freeze({ ...(environment as Readonly<Record<string, string>>) }),
        gitExecutable: executable,
    })
}

function ignoreProbeStep(
    id: string,
    input: EnvironmentIgnoreInput,
    args: readonly string[],
    filesystemChecks: readonly FilesystemCheck[],
): ExecutionStep {
    return probeStep(
        id,
        [input.gitExecutable.canonicalPath, '-c', 'core.excludesFile=/dev/null', '-C', input.siblingRoot, ...args],
        input.siblingRoot,
        input.env,
        input.gitExecutable,
        filesystemChecks,
    )
}

async function probeBoolean(step: ExecutionStep): Promise<boolean | undefined> {
    const outcome = await authenticatedProbeOutcome(step)
    if (outcome?.kind === 'complete') return true
    return outcome?.kind === 'refusal'
        && outcome.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED
        && outcome.execution.started
        && outcome.execution.exitCode === 1
        && outcome.execution.signal === null
        ? false
        : undefined
}

interface EnvironmentIgnoreStatus {
    readonly instanceIgnored: boolean
    readonly templateIgnored: boolean
}

function gitDisplayedPath(path: string): string {
    return path.includes('"') ? `"${path.replaceAll('"', '\\"')}"` : path
}

function ignoredByMatchedPattern(detail: string): boolean | undefined {
    if (detail === '::') return false
    const delimiters = [...detail.matchAll(/:[1-9][0-9]*:/g)]
    const delimiter = delimiters[0]
    if (delimiters.length !== 1 || delimiter.index === undefined || delimiter.index === 0) return undefined
    const pattern = detail.slice(delimiter.index + delimiter[0].length)
    if (pattern.length === 0) return undefined
    return !pattern.startsWith('!')
}

function ignoreStatusOutput(
    bytes: Buffer,
    instance: string,
    template: string,
): EnvironmentIgnoreStatus | undefined {
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (!decoded.endsWith('\n') || decoded.includes('\0') || /\r/.test(decoded)) return undefined
        const lines = decoded.slice(0, -1).split('\n')
        if (lines.length !== 2) return undefined
        const statuses: boolean[] = []
        for (const [index, expectedPath] of [instance, template].entries()) {
            const separator = lines[index].lastIndexOf('\t')
            if (separator < 2 || lines[index].slice(separator + 1) !== gitDisplayedPath(expectedPath)) return undefined
            const detail = lines[index].slice(0, separator)
            const ignored = ignoredByMatchedPattern(detail)
            if (ignored === undefined) return undefined
            statuses.push(ignored)
        }
        return Object.freeze({ instanceIgnored: statuses[0], templateIgnored: statuses[1] })
    } catch {
        return undefined
    }
}

async function observeIgnoreStatus(
    step: ExecutionStep,
    instance: string,
    template: string,
): Promise<EnvironmentIgnoreStatus | undefined> {
    const outcome = await authenticatedProbeOutcome(step)
    if (!outcome || outcome.stderr.byteLength !== 0
        || outcome.execution.stderrObservedBytes !== 0
        || outcome.execution.stdoutObservedBytes !== outcome.stdout.byteLength) return undefined
    const exitCode = outcome.kind === 'complete'
        ? 0
        : outcome.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED
            && outcome.execution.started
            && outcome.execution.exitCode === 1
            && outcome.execution.signal === null
            ? 1
            : undefined
    if (exitCode === undefined) return undefined
    const status = ignoreStatusOutput(outcome.stdout, instance, template)
    if (!status || (status.instanceIgnored || status.templateIgnored) !== (exitCode === 0)) return undefined
    return status
}

async function closedIdentity(path: string, identity: DirectoryIdentity): Promise<FilesystemCheck['identity'] | undefined> {
    const dev = Number(identity.dev)
    const ino = Number(identity.ino)
    if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) return undefined
    const parents: string[] = []
    let cursor = dirname(path)
    while (true) {
        parents.push(cursor)
        const parent = dirname(cursor)
        if (parent === cursor) break
        if (parents.length >= 64) return undefined
        cursor = parent
    }
    const ancestors = []
    for (const ancestorPath of parents.reverse()) {
        try {
            const status = await lstat(ancestorPath)
            if (!status.isDirectory() || status.isSymbolicLink()
                || !Number.isSafeInteger(status.dev) || !Number.isSafeInteger(status.ino)) return undefined
            ancestors.push(Object.freeze({ path: ancestorPath, dev: status.dev, ino: status.ino }))
        } catch {
            return undefined
        }
    }
    return Object.freeze({ dev, ino, ancestors: Object.freeze(ancestors) })
}

async function directoryCheck(path: string, identity: DirectoryIdentity): Promise<FilesystemCheck | undefined> {
    const value = await closedIdentity(path, identity)
    return value ? Object.freeze({ path, expected: 'directory' as const, identity: value }) : undefined
}

async function boundedFileCheck(path: string): Promise<FilesystemCheck | undefined> {
    const file = await stableFile(path)
    if (file) {
        const identity = await closedIdentity(path, file.identity)
        return identity ? Object.freeze({
            path,
            expected: 'file' as const,
            sha256: file.sha256,
            maxBytes: CONFIGURATION_BYTE_LIMIT,
            identity,
        }) : undefined
    }
    try {
        await lstat(path)
        return undefined
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? Object.freeze({ path, expected: 'absent' as const })
            : undefined
    }
}

function ignoreFiles(root: string, declarations: EnvironmentFileValue): readonly string[] | undefined {
    const result = new Set<string>()
    for (const relativePath of [declarations.instance, declarations.template]) {
        const absolute = resolve(root, relativePath)
        if (!confined(root, absolute)) return undefined
        let cursor = dirname(absolute)
        while (confined(root, cursor)) {
            result.add(resolve(cursor, '.gitignore'))
            if (cursor === root) break
            cursor = dirname(cursor)
        }
    }
    return [...result].sort()
}

async function ignoreRepositoryChecks(
    input: EnvironmentIgnoreInput,
    root: { canonicalPath: string; identity: DirectoryIdentity },
): Promise<readonly FilesystemCheck[] | undefined> {
    const rootCheck = await directoryCheck(root.canonicalPath, root.identity)
    if (!rootCheck) return undefined
    const identityStep = probeStep(
        'setup:observe:environment-repository',
        [
            input.gitExecutable.canonicalPath,
            '-c',
            'core.excludesFile=/dev/null',
            '-C',
            input.siblingRoot,
            'rev-parse',
            '--path-format=absolute',
            '--show-toplevel',
            '--absolute-git-dir',
            '--git-common-dir',
        ],
        input.siblingRoot,
        input.env,
        input.gitExecutable,
        [rootCheck],
    )
    const output = await authenticatedProbe(identityStep)
    const lines = output && exactLines(output, 3)
    if (!lines || !lines.every(canonicalAbsolutePath)) return undefined
    const [topLevel, gitDirectory, commonDirectory] = await Promise.all(lines.map(async (path) => {
        try { return await realpath(path) } catch { return undefined }
    }))
    if (topLevel !== root.canonicalPath || !gitDirectory || !commonDirectory) return undefined
    const [git, common] = await Promise.all([stableDirectory(gitDirectory), stableDirectory(commonDirectory)])
    if (!git || !common) return undefined
    const ignored = ignoreFiles(root.canonicalPath, input.environmentFile)
    if (!ignored) return undefined
    const dotGit = resolve(root.canonicalPath, '.git')
    let administrativeFile: string | undefined
    try {
        const status = await lstat(dotGit)
        if (status.isFile() && !status.isSymbolicLink()) administrativeFile = dotGit
        else if (!status.isDirectory() || status.isSymbolicLink()) return undefined
    } catch {
        return undefined
    }
    const administrative = await worktreeAdministrativeAuthority(common.canonicalPath)
    if (!administrative) return undefined
    const worktreeConfig = resolve(git.canonicalPath, 'config.worktree')
    const checks = await setupFilesystemChecks({
        sourcePath: input.source.path,
        directories: [root, git, common],
        configurationPaths: [resolve(common.canonicalPath, 'config')],
        administrativePaths: [
            ...(administrativeFile ? [administrativeFile] : []),
            ...administrative.paths,
        ],
        optionalFilePaths: [
            ...administrative.optionalFiles,
            worktreeConfig,
            resolve(git.canonicalPath, 'index'),
            resolve(common.canonicalPath, 'info', 'exclude'),
            ...ignored,
        ],
    })
    if (!checks) return undefined
    const configurationInventory = await authenticatedProbe(ignoreProbeStep(
        'setup:observe:environment-config-origins',
        input,
        ['config', '--show-origin', '--null', '--list'],
        checks,
    ))
    return configurationInventory
        && await validConfigurationInventory(configurationInventory, root.canonicalPath, [
            resolve(common.canonicalPath, 'config'),
            worktreeConfig,
        ])
        ? checks
        : undefined
}

export async function observeEnvironmentIgnore<T>(
    value: unknown,
    use: () => SynchronousResult<T>,
): Promise<SynchronousResult<T> | EnvironmentIgnoreRefusal | undefined> {
    const input = snapshotIgnoreInput(value)
    if (!input || typeof use !== 'function') return undefined
    const observedAt = Date.parse(input.observedAt)
    const issuedAt = Date.now()
    if (observedAt > issuedAt || issuedAt - observedAt > IGNORE_OBSERVATION_LIFETIME_MS) return undefined
    const root = await stableDirectory(input.siblingRoot)
    if (!root || deriveCheckoutId({ checkoutPath: root.canonicalPath }) !== input.checkoutId) return undefined
    const loaded = await loadCockpitConfig(input.source.path)
    if (loaded.kind === 'refusal' || !sameSource(loaded.result.source, input.source)) return undefined
    const [mainCheckout, siblingsDirectory] = await Promise.all([
        stableDirectory(input.mainCheckoutPath),
        stableDirectory(input.siblingsRoot),
    ])
    if (!mainCheckout || !siblingsDirectory) return undefined
    const sibling = loaded.result.config.sibling[input.siblingIndex]
    const environmentFile = sibling?.environment_files?.[input.environmentFileIndex]
    const expectedRoot = sibling ? resolve(input.siblingsRoot, sibling.dir) : undefined
    if (!sibling || sibling.slug !== input.siblingSlug || expectedRoot !== root.canonicalPath
        || resolve(dirname(loaded.result.source.path), loaded.result.config.cockpit.siblings_root) !== siblingsDirectory.canonicalPath
        || JSON.stringify(environmentFile) !== JSON.stringify(input.environmentFile)) return undefined
    const sanitizedInput = Object.freeze({ ...input, env: gitEnvironment(input.env) })
    const repositoryChecks = await ignoreRepositoryChecks(sanitizedInput, root)
    if (!repositoryChecks) return undefined

    const ignoreStatus = await observeIgnoreStatus(ignoreProbeStep(
        'setup:observe:environment-ignore',
        sanitizedInput,
        [
            '-c', 'core.quotePath=false',
            'check-ignore', '--verbose', '--non-matching', '--no-index', '--',
            input.environmentFile.instance, input.environmentFile.template,
        ],
        repositoryChecks,
    ), input.environmentFile.instance, input.environmentFile.template)
    const templateTracked = await probeBoolean(ignoreProbeStep(
        'setup:observe:environment-template-tracked',
        sanitizedInput,
        ['ls-files', '--error-unmatch', '--', input.environmentFile.template],
        repositoryChecks,
    ))
    if (!ignoreStatus) return undefined
    if (!ignoreStatus.instanceIgnored) return Object.freeze({
        kind: 'refusal', code: ENVIRONMENT_CODES.INSTANCE_NOT_IGNORED, path: input.environmentFile.instance,
    })
    if (templateTracked !== true) return Object.freeze({
        kind: 'refusal', code: ENVIRONMENT_CODES.TEMPLATE_NOT_TRACKED, path: input.environmentFile.template,
    })
    if (ignoreStatus.templateIgnored) return Object.freeze({
        kind: 'refusal', code: ENVIRONMENT_CODES.TEMPLATE_IGNORED, path: input.environmentFile.template,
    })

    const validThrough = observedAt + IGNORE_OBSERVATION_LIFETIME_MS
    const finalRoot = await authenticatedProbe(ignoreProbeStep(
        'setup:observe:environment-final-authority',
        sanitizedInput,
        ['rev-parse', '--path-format=absolute', '--show-toplevel'],
        repositoryChecks,
    ))
    if (!finalRoot || finalRoot.toString('utf8').trimEnd() !== root.canonicalPath
        || Date.now() > validThrough) return undefined

    const result: unknown = use()
    if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined)
        throw new TypeError('environment ignore projection callback must be synchronous')
    }
    return result as SynchronousResult<T>
}

interface SetupCheckoutBinding {
    readonly source: SourceProvenance
    readonly cockpitName: string
    readonly currentCheckoutPath: string
    readonly mainCheckoutPath: string
    readonly cockpitId: CockpitId
    readonly checkoutId: CheckoutId
    readonly observedAt: string
    readonly validThrough: string
    readonly sourceIdentity: FileIdentity
    readonly directoryIdentities: Readonly<Record<string, DirectoryIdentity>>
    readonly fileIdentities: Readonly<Record<string, StableFile>>
}

export type SetupCheckoutObservation = Readonly<{
    state: 'available'
    producer: typeof mechanism.id
    observedAt: string
    validThrough: string
}> | Readonly<{
    state: 'failed'
    producer: typeof mechanism.id
    code: typeof ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID
    reason: string
}>

export interface ConsumedSetupCheckoutObservation {
    readonly source: SourceProvenance
    readonly cockpitName: string
    readonly currentCheckoutPath: string
    readonly mainCheckoutPath: string
    readonly cockpitId: CockpitId
    readonly checkoutId: CheckoutId
    readonly observedAt: string
    readonly validThrough: string
}

declare const setupCheckoutProjectionBrand: unique symbol
export interface SetupCheckoutProjection {
    readonly [setupCheckoutProjectionBrand]: true
}

export interface SetupCheckoutObservationContext {
    readonly source: SourceProvenance
    readonly cockpitName: string
    readonly evaluatedAt: number
}

const issuedSetupCheckoutObservations = new WeakMap<object, SetupCheckoutBinding>()
const issuedSetupCheckoutProjections = new WeakMap<object, ConsumedSetupCheckoutObservation>()

interface SetupCheckoutInput {
    readonly source: SourceProvenance
    readonly cockpitName: string
    readonly observedAt: string
    readonly env: Readonly<Record<string, string>>
    readonly gitExecutable: ResolvedExecutable
}

function setupCheckoutFailure(reason: string): Extract<SetupCheckoutObservation, { state: 'failed' }> {
    return Object.freeze({
        state: 'failed',
        producer: mechanism.id,
        code: ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
        reason,
    })
}

function snapshotSetupCheckoutInput(input: unknown): SetupCheckoutInput | undefined {
    const snapshot = snapshotJson(input)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const value = snapshot as Record<string, unknown>
    const expectedKeys = ['cockpitName', 'env', 'gitExecutable', 'observedAt', 'source']
    const executable = resolvedGitExecutable(value.gitExecutable)
    if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')
        || !validSource(value.source)
        || typeof value.cockpitName !== 'string' || !COCKPIT_NAME.test(value.cockpitName)
        || !isCanonicalTimestamp(value.observedAt)
        || !executable
        || value.env === null || typeof value.env !== 'object' || Array.isArray(value.env)
        || Object.entries(value.env).some(([name, entry]) => name.length === 0 || name.includes('\0') || name.includes('=')
            || typeof entry !== 'string' || entry.includes('\0'))) return undefined
    return Object.freeze({
        source: Object.freeze({ ...value.source }),
        cockpitName: value.cockpitName,
        observedAt: value.observedAt,
        env: Object.freeze({ ...(value.env as Readonly<Record<string, string>>) }),
        gitExecutable: executable,
    })
}

function exactLines(bytes: Buffer, count: number): readonly string[] | undefined {
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (!decoded.endsWith('\n') || decoded.includes('\0') || /\r/.test(decoded)) return undefined
        const lines = decoded.slice(0, -1).split('\n')
        return lines.length === count && lines.every((line) => line.length > 0) ? lines : undefined
    } catch {
        return undefined
    }
}

function canonicalAbsolutePath(path: string): boolean {
    return isAbsolute(path) && normalize(path) === path && !/[\0\r\n]/.test(path)
}

interface WorktreeRecord {
    readonly path: string
}

function worktreeInventory(bytes: Buffer): readonly WorktreeRecord[] | undefined {
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (!decoded.endsWith('\0\0')) return undefined
        const records = decoded.slice(0, -2).split('\0\0')
        if (records.length === 0 || records.length > 4_096 || records.some((record) => record.length === 0)) return undefined
        const result: WorktreeRecord[] = []
        const paths = new Set<string>()
        for (const record of records) {
            const fields = record.split('\0')
            const worktree = fields.shift()
            if (!worktree?.startsWith('worktree ')) return undefined
            const path = worktree.slice('worktree '.length)
            if (!canonicalAbsolutePath(path) || paths.has(path)) return undefined
            paths.add(path)
            const kinds = new Set<string>()
            for (const field of fields) {
                const separator = field.indexOf(' ')
                const kind = separator === -1 ? field : field.slice(0, separator)
                const detail = separator === -1 ? '' : field.slice(separator + 1)
                if (kinds.has(kind) || !['HEAD', 'branch', 'bare', 'detached', 'locked', 'prunable'].includes(kind)) return undefined
                kinds.add(kind)
                if (kind === 'HEAD' && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(detail)) return undefined
                if (kind === 'branch' && !validRefName(detail)) return undefined
                if ((kind === 'bare' || kind === 'detached') && detail !== '') return undefined
            }
            const modeCount = Number(kinds.has('branch')) + Number(kinds.has('bare')) + Number(kinds.has('detached'))
            if (modeCount !== 1 || (kinds.has('bare') ? kinds.has('HEAD') || kinds.has('branch') || kinds.has('detached') : !kinds.has('HEAD'))) {
                return undefined
            }
            result.push(Object.freeze({ path }))
        }
        return Object.freeze(result)
    } catch {
        return undefined
    }
}

function validRefName(value: string): boolean {
    if (!value.startsWith('refs/') || value.endsWith('/') || value.endsWith('.') || value.includes('//')
        || value.includes('..') || value.includes('@{') || value === '@'
        || /[\x00-\x20\x7f~^:?*\\[]/.test(value)) return false
    return value.split('/').every((component) => component.length > 0 && component !== '.' && component !== '..'
        && !component.startsWith('.') && !component.endsWith('.lock'))
}

async function validConfigurationInventory(
    bytes: Buffer,
    checkout: string,
    allowedPaths: readonly string[],
): Promise<boolean> {
    let fields: string[]
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (!decoded.endsWith('\0')) return false
        fields = decoded.slice(0, -1).split('\0')
    } catch {
        return false
    }
    if (fields.length === 0 || fields.length % 2 !== 0 || fields.length > 8_192) return false
    const allowed = new Set(allowedPaths)
    for (let index = 0; index < fields.length; index += 2) {
        const origin = fields[index]
        const entry = fields[index + 1]
        if (!origin || entry === undefined) return false
        const separator = entry.indexOf('\n')
        if (separator <= 0) return false
        const key = entry.slice(0, separator)
        const value = entry.slice(separator + 1)
        if (key === 'include.path' || key.startsWith('includeif.')) return false
        if (origin === 'command line:') {
            if (key !== 'core.excludesfile' || value !== '/dev/null') return false
            continue
        }
        if (!origin.startsWith('file:')) return false
        const path = origin.slice('file:'.length)
        if (path.length === 0 || path.includes('\0')) return false
        let canonical
        try {
            canonical = await realpath(isAbsolute(path) ? path : resolve(checkout, path))
        } catch {
            return false
        }
        if (!allowed.has(canonical)) return false
    }
    return true
}

async function authorityFingerprint(checks: readonly FilesystemCheck[]): Promise<string | undefined> {
    const result: unknown[] = []
    for (const check of checks) {
        if (check.identity) {
            for (const ancestor of check.identity.ancestors) {
                try {
                    const status = await lstat(ancestor.path)
                    if (!status.isDirectory() || status.isSymbolicLink()
                        || status.dev !== ancestor.dev || status.ino !== ancestor.ino) return undefined
                } catch {
                    return undefined
                }
            }
        }
        if (check.expected === 'absent') {
            try {
                await lstat(check.path)
                return undefined
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
                result.push([check.path, 'absent'])
                continue
            }
        }
        if (check.expected === 'directory') {
            const directory = await stableDirectory(check.path)
            if (!directory || (check.identity
                && (Number(directory.identity.dev) !== check.identity.dev || Number(directory.identity.ino) !== check.identity.ino))) return undefined
            result.push([check.path, 'directory', directory.identity])
            continue
        }
        const file = await stableFile(check.path)
        if (!file || (check.maxBytes !== undefined && file.byteLength > check.maxBytes)
            || (check.sha256 !== undefined && file.sha256 !== check.sha256)
            || (check.identity && (Number(file.identity.dev) !== check.identity.dev || Number(file.identity.ino) !== check.identity.ino))) return undefined
        result.push([check.path, 'file', file])
    }
    return JSON.stringify(result)
}

async function authenticatedProbeOutcome(step: ExecutionStep) {
    const before = await authorityFingerprint(step.filesystemChecks)
    if (!before) return undefined
    const outcome = authenticatedExecutionOutcome(await executeProbe(step), step)
    const after = await authorityFingerprint(step.filesystemChecks)
    return after === before ? outcome : undefined
}

async function authenticatedProbe(step: ExecutionStep): Promise<Buffer | undefined> {
    const outcome = await authenticatedProbeOutcome(step)
    return outcome?.kind === 'complete' ? outcome.stdout : undefined
}

function setupProbeStep(
    id: string,
    executable: ResolvedExecutable,
    env: Readonly<Record<string, string>>,
    checkout: string,
    args: readonly string[],
    filesystemChecks: readonly FilesystemCheck[] = [],
): ExecutionStep {
    return probeStep(
        id,
        [executable.canonicalPath, '-c', 'core.excludesFile=/dev/null', '-C', checkout, ...args],
        checkout,
        env,
        executable,
        filesystemChecks,
    )
}

async function canonicalDirectory(path: string): Promise<{ canonicalPath: string; identity: DirectoryIdentity } | undefined> {
    if (!canonicalAbsolutePath(path)) return undefined
    return stableDirectory(path)
}

async function setupFilesystemChecks(input: {
    readonly sourcePath: string
    readonly directories: readonly { canonicalPath: string; identity: DirectoryIdentity }[]
    readonly configurationPaths?: readonly string[]
    readonly administrativePaths?: readonly string[]
    readonly optionalFilePaths?: readonly string[]
}): Promise<readonly FilesystemCheck[] | undefined> {
    const checks = new Map<string, FilesystemCheck>()
    const source = await boundedFileCheck(input.sourcePath)
    if (!source) return undefined
    checks.set(source.path, source)
    for (const directory of input.directories) {
        const check = await directoryCheck(directory.canonicalPath, directory.identity)
        if (!check) return undefined
        checks.set(check.path, check)
    }
    for (const path of input.configurationPaths ?? []) {
        const check = await boundedFileCheck(path)
        if (!check || check.expected !== 'file') return undefined
        checks.set(check.path, check)
    }
    for (const path of input.administrativePaths ?? []) {
        try {
            const status = await lstat(path)
            if (status.isDirectory() && !status.isSymbolicLink()) {
                const directory = await stableDirectory(path)
                if (!directory) return undefined
                const check = await directoryCheck(directory.canonicalPath, directory.identity)
                if (!check) return undefined
                checks.set(check.path, check)
            } else if (status.isFile() && !status.isSymbolicLink()) {
                const check = await boundedFileCheck(path)
                if (!check || check.expected !== 'file') return undefined
                checks.set(check.path, check)
            } else return undefined
        } catch {
            return undefined
        }
    }
    for (const path of input.optionalFilePaths ?? []) {
        const check = await boundedFileCheck(path)
        if (!check) return undefined
        checks.set(check.path, check)
    }
    return Object.freeze([...checks.values()])
}

interface WorktreeAdministrativeAuthority {
    readonly paths: readonly string[]
    readonly optionalFiles: readonly string[]
}

async function worktreeAdministrativeAuthority(commonDirectory: string): Promise<WorktreeAdministrativeAuthority | undefined> {
    const root = resolve(commonDirectory, 'worktrees')
    try {
        const rootStatus = await lstat(root)
        if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) return undefined
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? Object.freeze({ paths: Object.freeze([]), optionalFiles: Object.freeze([]) })
            : undefined
    }
    let entries
    try {
        entries = await readdir(root, { withFileTypes: true })
    } catch {
        return undefined
    }
    if (entries.length > 4_096 || entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) return undefined
    const directories = entries.map((entry) => resolve(root, entry.name)).sort()
    const optionalFiles = directories.flatMap((directory) => ['gitdir', 'HEAD', 'commondir', 'locked']
        .map((name) => resolve(directory, name)))
    return Object.freeze({ paths: Object.freeze([root, ...directories]), optionalFiles: Object.freeze(optionalFiles) })
}

async function gitIdentity(
    id: string,
    checkout: string,
    input: SetupCheckoutInput,
    filesystemChecks: readonly FilesystemCheck[] = [],
): Promise<Readonly<{ topLevel: string; gitDirectory: string; commonDirectory: string }> | undefined> {
    const output = await authenticatedProbe(setupProbeStep(id, input.gitExecutable, input.env, checkout, [
        'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir',
    ], filesystemChecks))
    const lines = output && exactLines(output, 3)
    if (!lines || !lines.every(canonicalAbsolutePath)) return undefined
    const [topLevel, gitDirectory, commonDirectory] = await Promise.all(lines.map(async (path) => {
        try { return await realpath(path) } catch { return undefined }
    }))
    return topLevel && gitDirectory && commonDirectory
        ? Object.freeze({ topLevel, gitDirectory, commonDirectory })
        : undefined
}

function sameGitIdentity(
    left: Readonly<{ topLevel: string; gitDirectory: string; commonDirectory: string }>,
    right: Readonly<{ topLevel: string; gitDirectory: string; commonDirectory: string }>,
): boolean {
    return left.topLevel === right.topLevel && left.gitDirectory === right.gitDirectory
        && left.commonDirectory === right.commonDirectory
}

export async function observeSetupCheckout(input: unknown): Promise<SetupCheckoutObservation> {
    const supplied = snapshotSetupCheckoutInput(input)
    if (!supplied) return setupCheckoutFailure('setup checkout observation input is malformed')
    const value = Object.freeze({ ...supplied, env: gitEnvironment(supplied.env) })
    const issuedAt = Date.now()
    const observedAt = Date.parse(value.observedAt)
    if (observedAt > issuedAt || issuedAt - observedAt > SETUP_CHECKOUT_OBSERVATION_LIFETIME_MS) {
        return setupCheckoutFailure('setup checkout observation time is outside the freshness window')
    }
    const source = await stableFile(value.source.path)
    if (!source || source.byteLength !== value.source.byteLength || source.sha256 !== value.source.sha256) {
        return setupCheckoutFailure('configuration source does not match its declared identity')
    }
    const startingDirectory = await canonicalDirectory(dirname(value.source.path))
    if (!startingDirectory) return setupCheckoutFailure('configuration directory is unavailable')
    const sourceChecks = await setupFilesystemChecks({
        sourcePath: value.source.path,
        directories: [startingDirectory],
    })
    if (!sourceChecks) return setupCheckoutFailure('configuration source authority is unavailable')
    const current = await gitIdentity(
        'setup:observe:checkout-current',
        startingDirectory.canonicalPath,
        value,
        sourceChecks,
    )
    if (!current || !confined(current.topLevel, value.source.path)) {
        return setupCheckoutFailure('Git could not authenticate the current checkout; setup requires a Git working tree to bound repository writes. '
            + `Inspect it with ${formatShellCommand(['git', '-C', startingDirectory.canonicalPath, 'rev-parse', '--show-toplevel'])}; `
            + `if this is a new directory, initialize it with ${formatShellCommand(['git', '-C', startingDirectory.canonicalPath, 'init'])}, `
            + `then retry ${cockpitCommand('setup', { config: value.source.path })}`)
    }
    const currentDirectories = await Promise.all(
        [...new Set([current.topLevel, current.gitDirectory, current.commonDirectory])].map(canonicalDirectory),
    )
    if (currentDirectories.some((entry) => !entry)) return setupCheckoutFailure('current checkout identity paths are unavailable')
    const currentAdministrative = await worktreeAdministrativeAuthority(current.commonDirectory)
    if (!currentAdministrative) return setupCheckoutFailure('worktree administrative authority is unavailable')
    const currentWorktreeConfiguration = resolve(current.gitDirectory, 'config.worktree')
    const currentChecks = await setupFilesystemChecks({
        sourcePath: value.source.path,
        directories: currentDirectories as { canonicalPath: string; identity: DirectoryIdentity }[],
        configurationPaths: [resolve(current.commonDirectory, 'config')],
        administrativePaths: [resolve(current.topLevel, '.git'), ...currentAdministrative.paths],
        optionalFilePaths: [...currentAdministrative.optionalFiles, currentWorktreeConfiguration],
    })
    if (!currentChecks) return setupCheckoutFailure('current checkout authority is unavailable')
    const configurationArguments = ['config', '--show-origin', '--null', '--list'] as const
    const configurationInventory = await authenticatedProbe(setupProbeStep(
        'setup:observe:checkout-config-origins',
        value.gitExecutable,
        value.env,
        current.topLevel,
        configurationArguments,
        currentChecks,
    ))
    const allowedCurrentConfigurations = [resolve(current.commonDirectory, 'config'), currentWorktreeConfiguration]
    if (!configurationInventory
        || !await validConfigurationInventory(configurationInventory, current.topLevel, allowedCurrentConfigurations)) {
        return setupCheckoutFailure('Git configuration origins are unsupported')
    }
    const worktrees = await authenticatedProbe(setupProbeStep(
        'setup:observe:checkout-worktrees',
        value.gitExecutable,
        value.env,
        current.topLevel,
        ['worktree', 'list', '--porcelain', '-z'],
        currentChecks,
    ))
    const inventory = worktrees && worktreeInventory(worktrees)
    if (!inventory) return setupCheckoutFailure('Git returned an invalid worktree inventory')
    const first = inventory[0]
    if (!first) return setupCheckoutFailure('Git returned an empty worktree inventory')
    const directMembership = inventory.filter((record) => record.path === current.topLevel).length
    const separateMain = first.path === current.commonDirectory && current.gitDirectory === current.commonDirectory
    if (directMembership + Number(separateMain) !== 1) {
        return setupCheckoutFailure('current checkout is not uniquely present in the worktree inventory')
    }
    const declaredMain = first.path
    const mainProbeRoot = separateMain ? current.topLevel : declaredMain
    const main = await gitIdentity('setup:observe:checkout-main', mainProbeRoot, value, currentChecks)
    if (!main || main.topLevel !== mainProbeRoot || main.commonDirectory !== current.commonDirectory) {
        return setupCheckoutFailure('Git could not authenticate the main checkout; setup requires its Git working-tree identity to bound repository writes. '
            + `Inspect it with ${formatShellCommand(['git', '-C', mainProbeRoot, 'rev-parse', '--show-toplevel'])}, `
            + `restore the intended checkout, then retry ${cockpitCommand('setup', { config: value.source.path })}`)
    }
    if (current.topLevel !== main.topLevel) {
        const mainDotGit = await stableDirectory(resolve(main.topLevel, '.git'))
        if (!mainDotGit || main.gitDirectory !== mainDotGit.canonicalPath || main.commonDirectory !== mainDotGit.canonicalPath) {
            return setupCheckoutFailure('linked checkout uses an unsupported external Git directory')
        }
    }
    const paths = [...new Set([
        current.topLevel,
        current.gitDirectory,
        current.commonDirectory,
        main.topLevel,
        main.gitDirectory,
        main.commonDirectory,
    ])]
    const observedDirectories = await Promise.all(paths.map(canonicalDirectory))
    if (observedDirectories.some((entry) => !entry)) return setupCheckoutFailure('checkout identity paths are unavailable')
    const allAdministrative = await worktreeAdministrativeAuthority(current.commonDirectory)
    if (!allAdministrative) return setupCheckoutFailure('worktree administrative authority is unavailable')
    const worktreeConfigurationPaths = [...new Set([
        resolve(current.gitDirectory, 'config.worktree'), resolve(main.gitDirectory, 'config.worktree'),
    ])]
    const allChecks = await setupFilesystemChecks({
        sourcePath: value.source.path,
        directories: observedDirectories as { canonicalPath: string; identity: DirectoryIdentity }[],
        configurationPaths: [resolve(current.commonDirectory, 'config'), resolve(main.commonDirectory, 'config')],
        administrativePaths: [resolve(current.topLevel, '.git'), resolve(main.topLevel, '.git'), ...allAdministrative.paths],
        optionalFilePaths: [...allAdministrative.optionalFiles, ...worktreeConfigurationPaths],
    })
    if (!allChecks) return setupCheckoutFailure('checkout authority is unavailable')
    if (main.topLevel !== current.topLevel) {
        const mainConfigurationInventory = await authenticatedProbe(setupProbeStep(
            'setup:observe:checkout-main-config-origins',
            value.gitExecutable,
            value.env,
            main.topLevel,
            configurationArguments,
            allChecks,
        ))
        const allowedMainConfigurations = [
            resolve(main.commonDirectory, 'config'), resolve(main.gitDirectory, 'config.worktree'),
        ]
        if (!mainConfigurationInventory
            || !await validConfigurationInventory(mainConfigurationInventory, main.topLevel, allowedMainConfigurations)) {
            return setupCheckoutFailure('main checkout Git configuration origins are unsupported')
        }
    }
    const confirmedCurrent = await gitIdentity('setup:observe:checkout-current-confirm', current.topLevel, value, allChecks)
    const confirmedMain = await gitIdentity('setup:observe:checkout-main-confirm', main.topLevel, value, allChecks)
    if (!confirmedCurrent || !confirmedMain || !sameGitIdentity(current, confirmedCurrent)
        || !sameGitIdentity(main, confirmedMain)) {
        return setupCheckoutFailure('checkout identity changed during observation')
    }
    const administrativeDirectories: { canonicalPath: string; identity: DirectoryIdentity }[] = []
    const administrativeFiles: [string, StableFile][] = []
    for (const path of [...new Set([
        resolve(current.topLevel, '.git'), resolve(main.topLevel, '.git'),
        ...allAdministrative.paths, ...allAdministrative.optionalFiles, ...worktreeConfigurationPaths,
    ])]) {
        try {
            const status = await lstat(path)
            if (status.isDirectory() && !status.isSymbolicLink()) {
                const directory = await stableDirectory(path)
                if (!directory) return setupCheckoutFailure('Git administrative entry is unavailable')
                administrativeDirectories.push(directory)
            } else if (status.isFile() && !status.isSymbolicLink()) {
                const file = await stableFile(path)
                if (!file) return setupCheckoutFailure('Git administrative entry is unavailable')
                administrativeFiles.push([path, file])
            } else return setupCheckoutFailure('Git administrative entry is invalid')
        } catch (error) {
            if ((allAdministrative.optionalFiles.includes(path) || worktreeConfigurationPaths.includes(path))
                && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
            return setupCheckoutFailure('Git administrative entry is unavailable')
        }
    }
    const directoryIdentities = Object.freeze(Object.fromEntries(
        [...observedDirectories.map((entry) => entry!), ...administrativeDirectories]
            .map((entry) => [entry.canonicalPath, entry.identity]),
    ))
    const configurationPaths = [...new Set([
        resolve(current.commonDirectory, 'config'),
        resolve(main.commonDirectory, 'config'),
    ])]
    const configurationFiles = await Promise.all(configurationPaths.map(stableFile))
    if (configurationFiles.some((entry) => !entry)) return setupCheckoutFailure('Git configuration is unavailable')
    const fileIdentities = Object.freeze(Object.fromEntries([
        ...configurationPaths.map((path, index): [string, StableFile] => [path, configurationFiles[index] as StableFile]),
        ...administrativeFiles,
    ]))
    const validThrough = new Date(observedAt + SETUP_CHECKOUT_OBSERVATION_LIFETIME_MS).toISOString()
    const binding: SetupCheckoutBinding = Object.freeze({
        source: value.source,
        cockpitName: value.cockpitName,
        currentCheckoutPath: current.topLevel,
        mainCheckoutPath: main.topLevel,
        cockpitId: deriveCockpitId({ name: value.cockpitName, mainCheckoutPath: main.topLevel }),
        checkoutId: deriveCheckoutId({ checkoutPath: current.topLevel }),
        observedAt: value.observedAt,
        validThrough,
        sourceIdentity: source.identity,
        directoryIdentities,
        fileIdentities,
    })
    const observation = Object.freeze({ state: 'available' as const, producer: mechanism.id, observedAt: value.observedAt, validThrough })
    issuedSetupCheckoutObservations.set(observation, binding)
    return observation
}

function sameSource(left: SourceProvenance, right: SourceProvenance): boolean {
    return left.path === right.path && left.byteLength === right.byteLength && left.sha256 === right.sha256
}

function snapshotSetupCheckoutContext(value: unknown): SetupCheckoutObservationContext | undefined {
    const snapshot = snapshotJson(value)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const context = snapshot as Record<string, unknown>
    const expectedKeys = ['cockpitName', 'evaluatedAt', 'source']
    return Object.keys(context).sort().join('\0') === expectedKeys.join('\0')
        && validSource(context.source)
        && typeof context.cockpitName === 'string' && COCKPIT_NAME.test(context.cockpitName)
        && Number.isSafeInteger(context.evaluatedAt)
        ? Object.freeze({
            source: Object.freeze({ ...context.source }),
            cockpitName: context.cockpitName,
            evaluatedAt: context.evaluatedAt as number,
        })
        : undefined
}

export async function withSetupCheckoutProjection<T>(
    observation: unknown,
    expected: SetupCheckoutObservationContext,
    use: (projection: SetupCheckoutProjection) => SynchronousResult<T>,
): Promise<SynchronousResult<T> | undefined> {
    if (observation === null || typeof observation !== 'object') return undefined
    const binding = issuedSetupCheckoutObservations.get(observation)
    issuedSetupCheckoutObservations.delete(observation)
    const context = snapshotSetupCheckoutContext(expected)
    const now = Date.now()
    if (!binding || !context || typeof use !== 'function'
        || !sameSource(binding.source, context.source) || binding.cockpitName !== context.cockpitName
        || context.evaluatedAt !== Date.parse(binding.observedAt) || context.evaluatedAt > now
        || now > Date.parse(binding.validThrough)) return undefined
    if (!await checkoutBindingCurrent(binding)) return undefined
    const consumed: ConsumedSetupCheckoutObservation = Object.freeze({
        source: binding.source,
        cockpitName: binding.cockpitName,
        currentCheckoutPath: binding.currentCheckoutPath,
        mainCheckoutPath: binding.mainCheckoutPath,
        cockpitId: binding.cockpitId,
        checkoutId: binding.checkoutId,
        observedAt: binding.observedAt,
        validThrough: binding.validThrough,
    })
    const projection = Object.freeze({}) as SetupCheckoutProjection
    issuedSetupCheckoutProjections.set(projection, consumed)
    try {
        const result: unknown = use(projection)
        if (isPromiseLike(result)) {
            void Promise.resolve(result).catch(() => undefined)
            throw new TypeError('setup checkout projection callback must be synchronous')
        }
        return result as SynchronousResult<T>
    } finally {
        issuedSetupCheckoutProjections.delete(projection)
    }
}

async function checkoutBindingCurrent(binding: SetupCheckoutBinding, publication = false): Promise<boolean> {
    const source = await stableFile(binding.source.path)
    if (!source || !sameFileIdentity(source.identity, binding.sourceIdentity)
        || source.byteLength !== binding.source.byteLength || source.sha256 !== binding.source.sha256) return false
    for (const [path, identity] of Object.entries(binding.directoryIdentities)) {
        const current = await stableDirectory(path)
        // Publishing files changes checkout directory timestamps, but never its inode or Git administration.
        const matches = current && (publication && (path === binding.currentCheckoutPath || path === binding.mainCheckoutPath)
            ? sameDirectoryNode(current.identity, identity) : sameDirectoryIdentity(current.identity, identity))
        if (!matches) return false
    }
    for (const [path, identity] of Object.entries(binding.fileIdentities)) {
        const current = await stableFile(path)
        if (!current || !sameFileIdentity(current.identity, identity.identity)
            || current.byteLength !== identity.byteLength || current.sha256 !== identity.sha256) return false
    }
    return true
}

export function consumeSetupCheckoutProjection(
    projection: SetupCheckoutProjection,
): ConsumedSetupCheckoutObservation | undefined {
    try {
        if (projection === null || typeof projection !== 'object') return undefined
        const binding = issuedSetupCheckoutProjections.get(projection)
        if (!binding) return undefined
        issuedSetupCheckoutProjections.delete(projection)
        return binding
    } catch {
        return undefined
    }
}

export interface GeneratedCheckoutIdentity {
    readonly state: 'available'
    readonly kind: 'checkout' | 'standalone'
    readonly cockpitId: CockpitId
    readonly checkoutId: CheckoutId
    readonly currentCheckoutPath: string
    readonly mainCheckoutPath: string
}

interface GeneratedCheckoutBinding {
    readonly source: SourceProvenance
    readonly sourceIdentity: FileIdentity
    readonly cockpitName: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly directories: ReadonlyMap<string, DirectoryIdentity>
    readonly absentGitEntries: readonly string[]
    readonly checkout?: SetupCheckoutBinding
    readonly observedAt: number
}

const issuedGeneratedCheckoutIdentities = new WeakMap<object, GeneratedCheckoutBinding>()

function captureGeneratedCheckoutInput(input: unknown): Readonly<{
    source: SourceProvenance
    cockpitName: string
    env: Readonly<Record<string, string | undefined>>
}> | undefined {
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = ['cockpitName', 'env', 'source']
        if (Reflect.ownKeys(descriptors).length !== keys.length
            || keys.some(key => !descriptors[key] || !Object.hasOwn(descriptors[key]!, 'value'))) return undefined
        const source = snapshotJson(descriptors.source!.value)
        const cockpitName = descriptors.cockpitName!.value
        const rawEnvironment = descriptors.env!.value
        if (!validSource(source) || typeof cockpitName !== 'string' || !COCKPIT_NAME.test(cockpitName)
            || rawEnvironment === null || typeof rawEnvironment !== 'object' || Array.isArray(rawEnvironment)
            || isProxy(rawEnvironment)) return undefined
        const environmentDescriptors = Object.getOwnPropertyDescriptors(rawEnvironment)
        const environmentKeys = Reflect.ownKeys(environmentDescriptors)
        if (environmentKeys.length > 4_096) return undefined
        const env: Record<string, string | undefined> = {}
        for (const key of environmentKeys) {
            if (typeof key !== 'string') return undefined
            if (key !== 'PATH') continue
            const descriptor = environmentDescriptors[key]!
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
                || descriptor.value !== undefined && (typeof descriptor.value !== 'string'
                    || descriptor.value.includes('\0') || Buffer.byteLength(descriptor.value) > 65_536)) return undefined
            env[key] = descriptor.value
        }
        return Object.freeze({ source: Object.freeze({ path: source.path, byteLength: source.byteLength, sha256: source.sha256 }),
            cockpitName, env: Object.freeze(env) })
    } catch {
        return undefined
    }
}

async function pathAbsent(path: string): Promise<boolean> {
    try { await lstat(path); return false } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
}

export async function observeGeneratedCheckoutIdentity(input: {
    readonly source: SourceProvenance
    readonly cockpitName: string
    readonly env: Readonly<Record<string, string | undefined>>
}): Promise<GeneratedCheckoutIdentity | Extract<SetupCheckoutObservation, { state: 'failed' }>> {
    const value = captureGeneratedCheckoutInput(input)
    if (!value) {
        return setupCheckoutFailure('generated checkout identity input is malformed')
    }
    const source = value.source
    const sourceFile = await stableFile(source.path)
    if (!sourceFile || sourceFile.sha256 !== source.sha256 || sourceFile.byteLength !== source.byteLength) {
        return setupCheckoutFailure('generated checkout configuration source is unavailable or changed')
    }
    const root = dirname(source.path)
    const directories = new Map<string, DirectoryIdentity>()
    const absentGitEntries: string[] = []
    let candidate = root
    let hasCheckout = false
    for (;;) {
        if (directories.size >= 256) return setupCheckoutFailure('generated checkout ancestor discovery exceeds its bound')
        const directory = await stableDirectoryNode(candidate)
        if (!directory) return setupCheckoutFailure('generated checkout ancestor cannot be authenticated')
        directories.set(candidate, directory.identity)
        const gitEntry = resolve(candidate, '.git')
        try {
            await lstat(gitEntry)
            hasCheckout = true
            break
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return setupCheckoutFailure('generated checkout Git entry cannot be observed')
        }
        absentGitEntries.push(gitEntry)
        const parent = dirname(candidate)
        if (parent === candidate) break
        candidate = parent
    }
    const searchEnvironment = value.env
    const observedAt = Date.now()
    if (!Number.isSafeInteger(observedAt)) return setupCheckoutFailure('generated checkout observation time is invalid')
    let checkout: SetupCheckoutBinding | undefined
    let consumed: ConsumedSetupCheckoutObservation | undefined
    if (hasCheckout) {
        const git = await resolveGitExecutable(searchEnvironment)
        if (git.state !== 'available') return setupCheckoutFailure(git.reason)
        const env = gitEnvironment(searchEnvironment)
        const observation = await observeSetupCheckout({ source, cockpitName: value.cockpitName,
            env, gitExecutable: git.value, observedAt: new Date(observedAt).toISOString() })
        if (observation.state === 'failed') return observation
        checkout = issuedSetupCheckoutObservations.get(observation)
        consumed = await withSetupCheckoutProjection(observation, {
            source, cockpitName: value.cockpitName, evaluatedAt: observedAt,
        }, consumeSetupCheckoutProjection)
        if (!checkout || !consumed) return setupCheckoutFailure('generated checkout observation changed before consumption')
    }
    const identity: GeneratedCheckoutIdentity = Object.freeze({
        state: 'available', kind: consumed ? 'checkout' : 'standalone',
        cockpitId: consumed?.cockpitId ?? deriveCockpitId({ name: value.cockpitName, mainCheckoutPath: root }),
        checkoutId: consumed?.checkoutId ?? deriveCheckoutId({ checkoutPath: root }),
        currentCheckoutPath: consumed?.currentCheckoutPath ?? root,
        mainCheckoutPath: consumed?.mainCheckoutPath ?? root,
    })
    const binding: GeneratedCheckoutBinding = Object.freeze({ source, sourceIdentity: sourceFile.identity,
        cockpitName: value.cockpitName, env: searchEnvironment, directories, absentGitEntries: Object.freeze(absentGitEntries),
        ...(checkout ? { checkout } : {}), observedAt })
    const current = await generatedCheckoutBindingCurrent(binding)
    const completedAt = Date.now()
    if (!current || !Number.isSafeInteger(completedAt) || completedAt < observedAt
        || completedAt - observedAt > SETUP_CHECKOUT_OBSERVATION_LIFETIME_MS) {
        return setupCheckoutFailure('generated checkout identity changed or expired during observation')
    }
    issuedGeneratedCheckoutIdentities.set(identity, binding)
    return identity
}

async function generatedCheckoutBindingCurrent(binding: GeneratedCheckoutBinding): Promise<boolean> {
    const source = await stableFile(binding.source.path)
    if (!source || !sameFileIdentity(source.identity, binding.sourceIdentity)
        || source.sha256 !== binding.source.sha256 || source.byteLength !== binding.source.byteLength) return false
    for (const [path, expected] of binding.directories) {
        const current = await stableDirectoryNode(path)
        if (!current || !sameDirectoryNode(current.identity, expected)) return false
    }
    for (const path of binding.absentGitEntries) if (!await pathAbsent(path)) return false
    if (binding.checkout && !await checkoutBindingCurrent(binding.checkout, true)) return false
    return true
}

export async function revalidateGeneratedCheckoutIdentity(identity: GeneratedCheckoutIdentity): Promise<boolean> {
    const binding = identity && typeof identity === 'object' ? issuedGeneratedCheckoutIdentities.get(identity) : undefined
    const now = Date.now()
    if (!binding || !Number.isSafeInteger(now) || now < binding.observedAt
        || !await generatedCheckoutBindingCurrent(binding)) return false
    const completedAt = Date.now()
    if (!Number.isSafeInteger(completedAt) || completedAt < now) return false
    if (completedAt - binding.observedAt > SETUP_CHECKOUT_OBSERVATION_LIFETIME_MS) {
        const refreshed = await observeGeneratedCheckoutIdentity({ source: binding.source, cockpitName: binding.cockpitName, env: binding.env })
        if (refreshed.state !== 'available' || refreshed.kind !== identity.kind
            || refreshed.cockpitId !== identity.cockpitId || refreshed.checkoutId !== identity.checkoutId
            || refreshed.mainCheckoutPath !== identity.mainCheckoutPath || refreshed.currentCheckoutPath !== identity.currentCheckoutPath) return false
        const current = issuedGeneratedCheckoutIdentities.get(refreshed)
        const refreshedAt = Date.now()
        if (!current || !Number.isSafeInteger(refreshedAt) || refreshedAt < current.observedAt
            || refreshedAt - current.observedAt > SETUP_CHECKOUT_OBSERVATION_LIFETIME_MS) return false
        issuedGeneratedCheckoutIdentities.set(identity, current)
        issuedGeneratedCheckoutIdentities.delete(refreshed)
    }
    return true
}

function confined(root: string, candidate: string): boolean {
    const fromRoot = relative(root, candidate)
    return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

function probeStep(
    id: string,
    argv: readonly [string, ...string[]],
    cwd: string,
    env: Readonly<Record<string, string>>,
    executable: ResolvedExecutable,
    filesystemChecks: readonly FilesystemCheck[] = [],
): ExecutionStep {
    return {
        id,
        argv,
        argv0: executable.invocationPath,
        cwd,
        env,
        timeoutMs: 10_000,
        stdoutLimitBytes: 65_536,
        stderrLimitBytes: 65_536,
        paths: [cwd],
        ports: [],
        labels: {},
        expected: [],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
        filesystemChecks,
        compensation: [],
    }
}

function available(value: SetupPathEvidence): SetupObservation {
    return { state: 'available', value, observedAt: new Date().toISOString(), producer: mechanism.id }
}

function outsideRoot(): SetupObservation {
    return {
        state: 'failed',
        code: ENVIRONMENT_CODES.SETUP_PATH_OUTSIDE_ROOT,
        reason: 'the checkout or its Git administrative directory is outside the declared siblings root',
        producer: mechanism.id,
    }
}

function failure(message: string, code: RefusalCode = ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID): SetupObservation {
    return { state: 'failed', code, reason: message, producer: mechanism.id }
}

function decodeLines(bytes: Buffer): readonly string[] | undefined {
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return source.trimEnd().split(/\r?\n/)
    } catch {
        return undefined
    }
}

async function pathChecks(target: string, siblingsRoot: string): Promise<
    | { kind: 'observation'; observation: SetupObservation; checks: FilesystemCheck[] }
    | { kind: 'continue'; checks: FilesystemCheck[] }
> {
    const checks: FilesystemCheck[] = []
    const addDirectoryCheck = async (path: string): Promise<boolean> => {
        const directory = await stableDirectory(path)
        if (!directory) return false
        const check = await directoryCheck(directory.canonicalPath, directory.identity)
        if (!check) return false
        checks.push(check)
        return true
    }
    let current = siblingsRoot
    try {
        const components = relative(siblingsRoot, target).split(sep).filter(Boolean)
        for (const component of components) {
            let stat
            try {
                stat = await lstat(current)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT' && current !== siblingsRoot) {
                    return {
                        kind: 'observation',
                        observation: available({
                            kind: 'absent',
                            missingParent: current,
                            filesystemChecks: [...checks, { path: current, expected: 'absent' }],
                        }),
                        checks,
                    }
                }
                throw error
            }
            if (stat.isSymbolicLink()) {
                return { kind: 'observation', observation: available({ kind: 'symlink' }), checks }
            }
            if (!stat.isDirectory()) {
                return { kind: 'observation', observation: available({ kind: 'directory' }), checks }
            }
            if (!await addDirectoryCheck(current)) {
                return { kind: 'observation', observation: failure('a sibling path component changed during inspection'), checks }
            }
            current = resolve(current, component)
        }
        try {
            const stat = await lstat(target)
            if (stat.isSymbolicLink()) return { kind: 'observation', observation: available({ kind: 'symlink' }), checks }
            if (!stat.isDirectory()) return { kind: 'observation', observation: available({ kind: 'directory' }), checks }
            if (!await addDirectoryCheck(target)) {
                return { kind: 'observation', observation: failure('the sibling directory changed during inspection'), checks }
            }
            const dotGit = resolve(target, '.git')
            let dotGitStat
            try {
                dotGitStat = await lstat(dotGit)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return {
                        kind: 'observation',
                        observation: available({ kind: 'directory', filesystemChecks: checks }),
                        checks,
                    }
                }
                return { kind: 'observation', observation: failure('the .git entry could not be inspected'), checks }
            }
            if (dotGitStat.isSymbolicLink()) return { kind: 'observation', observation: available({ kind: 'symlink' }), checks }
            if (dotGitStat.isDirectory()) {
                if (!await addDirectoryCheck(dotGit)) {
                    return { kind: 'observation', observation: failure('the Git administrative directory changed during inspection'), checks }
                }
            }
            else if (dotGitStat.isFile()) {
                if (dotGitStat.nlink !== 1 || dotGitStat.size > CONFIGURATION_BYTE_LIMIT) {
                    return { kind: 'observation', observation: failure('the .git entry is not a bounded private file'), checks }
                }
                const bytes = await readFile(dotGit)
                const after = await lstat(dotGit)
                if (after.nlink !== 1 || after.dev !== dotGitStat.dev || after.ino !== dotGitStat.ino
                    || after.size !== dotGitStat.size || after.mtimeMs !== dotGitStat.mtimeMs) {
                    return { kind: 'observation', observation: failure('the .git entry changed during inspection'), checks }
                }
                let canonicalDotGit: string
                try { canonicalDotGit = await realpath(dotGit) } catch {
                    return { kind: 'observation', observation: failure('the .git entry changed during inspection'), checks }
                }
                const check = await boundedFileCheck(canonicalDotGit)
                if (!check || check.expected !== 'file') {
                    return { kind: 'observation', observation: failure('the .git entry changed during inspection'), checks }
                }
                checks.push(check)
            } else return { kind: 'observation', observation: failure('the .git entry has an invalid type'), checks }
            return { kind: 'continue', checks }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {
                kind: 'observation',
                observation: available({ kind: 'absent', filesystemChecks: [...checks, { path: target, expected: 'absent' }] }),
                checks,
            }
            return { kind: 'observation', observation: failure('the sibling path could not be inspected'), checks }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
                kind: 'observation',
                observation: failure('the siblings root is absent'),
                checks,
            }
        }
        return { kind: 'observation', observation: failure('the siblings root could not be inspected'), checks }
    }
}

export async function observeSetupPath(
    target: string,
    siblingsRoot: string,
    env: Readonly<Record<string, string>>,
    gitExecutable: ResolvedExecutable,
): Promise<SetupObservation> {
    const executable = resolvedGitExecutable(gitExecutable)
    if (executable === undefined) return failure('Git executable identity is unresolved')
    const inspected = await pathChecks(target, siblingsRoot)
    if (inspected.kind === 'observation') return inspected.observation

    const identityStep = probeStep(
        'setup:observe:identity',
        [executable.canonicalPath, '-C', target, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
        siblingsRoot,
        env,
        executable,
        inspected.checks,
    )
    const beforeIdentity = await authorityFingerprint(identityStep.filesystemChecks)
    if (!beforeIdentity) return failure('checkout identity changed during observation')
    const identityExecution = authenticatedExecutionOutcome(await executeProbe(identityStep), identityStep)
    const afterIdentity = await authorityFingerprint(identityStep.filesystemChecks)
    if (afterIdentity !== beforeIdentity) return failure('checkout identity changed during observation')
    if (!identityExecution || identityExecution.kind === 'refusal') return failure('Git could not identify the checkout')
    const lines = decodeLines(identityExecution.stdout)
    if (!lines || lines.length !== 3) return failure('Git returned invalid checkout identity')
    const [topLevel, gitDirectory, commonDirectory] = lines.map((path) => resolve(path))
    let canonicalRoot: string
    let canonicalTarget: string
    let canonicalGitDirectory: string
    let canonicalCommonDirectory: string
    try {
        canonicalRoot = await realpath(siblingsRoot)
        canonicalTarget = await realpath(target)
        canonicalGitDirectory = await realpath(gitDirectory)
        canonicalCommonDirectory = await realpath(commonDirectory)
    } catch {
        return failure('Git returned a path that could not be canonicalized')
    }
    if (
        resolve(topLevel) !== canonicalTarget ||
        !confined(canonicalRoot, canonicalGitDirectory) ||
        !confined(canonicalRoot, canonicalCommonDirectory)
    ) return outsideRoot()
    const identityDirectories = await Promise.all(
        [...new Set([canonicalTarget, canonicalGitDirectory, canonicalCommonDirectory])].map(canonicalDirectory),
    )
    if (identityDirectories.some((entry) => !entry)) return failure('checkout identity paths are unavailable')
    const exactChecks = await Promise.all(identityDirectories.map((directory) => directoryCheck(
        directory!.canonicalPath,
        directory!.identity,
    )))
    if (exactChecks.some((check) => !check)) return failure('checkout identity paths changed during inspection')
    const repositoryChecks = [...new Map([
        ...inspected.checks,
        ...(exactChecks as FilesystemCheck[]),
    ].map((check) => [check.path, check])).values()]
    const configPath = resolve(canonicalCommonDirectory, 'config')
    const worktreeConfigPath = resolve(canonicalGitDirectory, 'config.worktree')
    const configCheck = await boundedFileCheck(configPath)
    if (!configCheck || configCheck.expected !== 'file') {
        return failure('the Git configuration is not a stable private file')
    }
    const worktreeConfigCheck = await boundedFileCheck(worktreeConfigPath)
    if (!worktreeConfigCheck) return failure('the worktree Git configuration could not be inspected')
    repositoryChecks.push(configCheck, worktreeConfigCheck)

    const confirmedIdentity = await authenticatedProbe(probeStep(
        'setup:observe:identity-confirm',
        [executable.canonicalPath, '-C', target, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
        siblingsRoot,
        env,
        executable,
        repositoryChecks,
    ))
    const confirmedLines = confirmedIdentity && decodeLines(confirmedIdentity)
    if (!confirmedLines || confirmedLines.length !== 3
        || confirmedLines.map((path) => resolve(path)).join('\0') !== [topLevel, gitDirectory, commonDirectory].join('\0')) {
        return failure('checkout identity changed during observation')
    }

    const configurationInventory = await authenticatedProbe(probeStep(
        'setup:observe:config-origins',
        [executable.canonicalPath, '-c', 'core.excludesFile=/dev/null', '-C', target, 'config', '--show-origin', '--null', '--list'],
        siblingsRoot,
        env,
        executable,
        repositoryChecks,
    ))
    if (!configurationInventory || !await validConfigurationInventory(
        configurationInventory,
        canonicalTarget,
        [configPath, worktreeConfigPath],
    )) return failure('Git configuration origins are unsupported')

    const remote = await authenticatedProbeOutcome(probeStep(
        'setup:observe:origin',
        [executable.canonicalPath, '-C', target, 'config', '--get', 'remote.origin.url'],
        siblingsRoot,
        env,
        executable,
        repositoryChecks,
    ))
    if (!remote || (remote.kind === 'refusal' && remote.execution.exitCode !== 1)) {
        return failure('Git could not inspect the origin remote')
    }
    const remoteLines = remote.kind === 'complete' ? decodeLines(remote.stdout) : []
    if (remote.kind === 'complete' && (!remoteLines || remoteLines.length !== 1)) {
        return failure('Git returned an invalid origin remote')
    }
    return available({
        kind: 'repository',
        remotes: remoteLines?.[0] ? { origin: remoteLines[0] } : {},
        filesystemChecks: repositoryChecks,
    })
}
