/**
 * Owns which checkout serves each sibling: the directory cockpit.toml declares under siblings_root,
 * or another checkout of the same repository (a linked worktree, usually) that `cockpit use`
 * recorded for this cockpit checkout alone. Mounts, the guard's allowed roots and the health
 * commands all read the served directory from here, so they describe the same code.
 *
 * The record is machine-local, under `.cockpit/local`, never in cockpit.toml: a worktree path is
 * one person's disk, and a committed one would point every other clone at a directory it lacks.
 * Without it, an agent working on a branch in a sibling's worktree had the stack, the checks and
 * every grade run against the main checkout's branch while reporting green.
 */
import { lstatIfPresent } from './presence.js'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { readBoundedFile } from '../bounded-read.js'
import { cockpitCommand, formatShellCommand } from '../fix-catalogue.js'
import { GUARD_LOCAL_PATHS, writeCockpitLocalFiles } from '../guards/local-identity.js'
import type { CockpitConfig, Sibling } from '../schema.js'
import { ENVIRONMENT_CODES, errorCause, hasErrorCode, RefusalError, tryParseJson, type EnvironmentDiagnostic, type ExecutionStep } from './contract.js'
import { GIT_CHILD_CONFIG, resolveGitExecutable, type ResolvedExecutable } from './executable.js'
import { repositoryIdentity, type RepositoryIdentity } from './repository-identity.js'
import { redactSensitiveMessage } from './sensitive.js'
import { gitEnvironment } from './setup.js'

const FORMAT = 'cockpit-sibling-checkouts/v1'
const RECORD_NAME = 'sibling-checkouts'
export const SIBLING_CHECKOUTS_PATH = `${GUARD_LOCAL_PATHS.directory}/${RECORD_NAME}`
const RECORD_MAX_BYTES = 65_536
const SLUG = /^[a-z0-9][a-z0-9-]*$/

/** Each overridden sibling's slug and the canonical absolute directory that serves it. */
type SiblingCheckoutRecord = Readonly<Record<string, string>>

export type SiblingCheckoutRecordRead =
    | Readonly<{ kind: 'complete'; checkouts: SiblingCheckoutRecord }>
    | Readonly<{ kind: 'refusal'; diagnostic: EnvironmentDiagnostic }>

function canonicalDirectory(value: unknown): value is string {
    return typeof value === 'string' && isAbsolute(value) && normalize(value) === value && value !== '/'
        && !value.endsWith('/') && !/[\x00-\x1f\x7f]/.test(value)
}

function recordRefusal(path: string, reason: string): SiblingCheckoutRecordRead {
    return { kind: 'refusal', diagnostic: {
        severity: 'error',
        code: 'SIBLING_CHECKOUT_RECORD_INVALID' satisfies typeof ENVIRONMENT_CODES.SIBLING_CHECKOUT_RECORD_INVALID,
        message: `${path} is not a sibling checkout record cockpit wrote (${reason}), so cockpit cannot tell which checkout serves each sibling`,
        target: SIBLING_CHECKOUTS_PATH,
        fix: `delete ${path}, then run npx --no cockpit use <slug> <checkout> --config <your cockpit.toml> again for each sibling another checkout should serve`,
    } }
}

/** The recorded overrides; none when nothing was recorded. A record cockpit did not write is refused, never ignored. */
export async function readSiblingCheckouts(cockpitRoot: string): Promise<SiblingCheckoutRecordRead> {
    const path = join(cockpitRoot, SIBLING_CHECKOUTS_PATH)
    let bytes: Buffer
    try {
        const read = readBoundedFile(path, RECORD_MAX_BYTES)
        if (read.kind === 'too-large') return recordRefusal(path, `it is larger than ${RECORD_MAX_BYTES} bytes`)
        bytes = read.bytes
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { kind: 'complete', checkouts: {} }
        // ELOOP: a link at the last component; EISDIR: the reader's code for a file that is not regular.
        if (hasErrorCode(error, 'ELOOP', 'EISDIR')) return recordRefusal(path, 'it is not a plain file')
        return recordRefusal(path, `it could not be read: ${errorCause(error)}`)
    }
    const value = tryParseJson(bytes.toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return recordRefusal(path, 'it is not a JSON object')
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'checkouts,format' || record.format !== FORMAT) {
        return recordRefusal(path, `it does not carry the ${FORMAT} format`)
    }
    const checkouts = record.checkouts
    if (checkouts === null || typeof checkouts !== 'object' || Array.isArray(checkouts)
        || Object.entries(checkouts).some(([slug, directory]) => !SLUG.test(slug) || !canonicalDirectory(directory))) {
        return recordRefusal(path, 'a slug or directory in it is malformed')
    }
    return { kind: 'complete', checkouts: Object.freeze({ ...checkouts as Record<string, string> }) }
}

export async function writeSiblingCheckouts(cockpitRoot: string, checkouts: SiblingCheckoutRecord) {
    const ordered = Object.fromEntries(Object.entries(checkouts).sort(([left], [right]) => left < right ? -1 : 1))
    return writeCockpitLocalFiles(cockpitRoot, [{ name: RECORD_NAME, bytes: `${JSON.stringify({ format: FORMAT, checkouts: ordered })}\n` }])
}

export interface ServedSibling {
    readonly slug: string
    /** Where cockpit.toml puts the checkout. */
    readonly declared: string
    /** The checkout the stack, the guard and the health commands use. */
    readonly served: string
    readonly overridden: boolean
}

/** Every declared sibling with the directory that serves it; an override for an undeclared slug serves nothing. */
export function servedSiblings(cockpitRoot: string,
    config: Readonly<{ cockpit: Readonly<{ siblings_root: string }>; sibling: readonly Readonly<{ slug: string; dir: string }>[] }>,
    checkouts: SiblingCheckoutRecord): ReadonlyMap<string, ServedSibling> {
    const siblingsRoot = resolve(cockpitRoot, config.cockpit.siblings_root)
    return new Map(config.sibling.map(sibling => {
        const declared = resolve(siblingsRoot, sibling.dir)
        const override = Object.hasOwn(checkouts, sibling.slug) ? checkouts[sibling.slug] : undefined
        return [sibling.slug, Object.freeze({ slug: sibling.slug, declared, served: override ?? declared, overridden: override !== undefined })]
    }))
}

/** The directory serving a declared sibling; a slug the map lacks is a caller's error, named as one. */
export function servedPath(served: ReadonlyMap<string, ServedSibling>, slug: string): string {
    const entry = served.get(slug)
    if (!entry) throw new RefusalError(`sibling ${slug} has no served checkout; it is not declared in cockpit.toml`)
    return entry.served
}

type ServedSiblingsRead =
    | Readonly<{ kind: 'complete'; siblings: ReadonlyMap<string, ServedSibling> }>
    | Readonly<{ kind: 'refusal'; diagnostic: EnvironmentDiagnostic }>

export async function loadServedSiblings(cockpitRoot: string, config: Pick<CockpitConfig, 'cockpit' | 'sibling'>): Promise<ServedSiblingsRead> {
    const read = await readSiblingCheckouts(cockpitRoot)
    return read.kind === 'complete' ? { kind: 'complete', siblings: servedSiblings(cockpitRoot, config, read.checkouts) } : read
}

/** The overridden siblings whose recorded directory is gone, such as a removed worktree. */
export async function vanishedServedCheckouts(served: ReadonlyMap<string, ServedSibling>): Promise<readonly ServedSibling[]> {
    const overridden = [...served.values()].filter(sibling => sibling.overridden)
    const present = await Promise.all(overridden.map(async sibling => (await lstatIfPresent(sibling.served))?.isDirectory() === true))
    return overridden.filter((_, index) => !present[index])
}

export function vanishedCheckoutFix(slug: string): string {
    return `serve the declared checkout again with ${cockpitCommand('use', { operand: slug, args: '--clear' })}, or name another checkout of it`
}

/**
 * A refusal when an override names a directory that is gone. Docker creates a missing bind-mount
 * source as an empty directory, so the stack would start on nothing. Preflight and doctor report
 * the same fact as the served-checkouts observation row, so all three agree.
 */
export async function missingServedCheckout(served: ReadonlyMap<string, ServedSibling>): Promise<EnvironmentDiagnostic | undefined> {
    const [sibling] = await vanishedServedCheckouts(served)
    return sibling === undefined ? undefined : {
        severity: 'error',
        code: 'SIBLING_CHECKOUT_UNAVAILABLE' satisfies typeof ENVIRONMENT_CODES.SIBLING_CHECKOUT_UNAVAILABLE,
        message: `sibling ${sibling.slug} is recorded to be served from ${sibling.served}, which is no longer a directory`,
        target: sibling.served,
        fix: vanishedCheckoutFix(sibling.slug),
    }
}

/** The directory variables Compose interpolates: each sibling's `var` and the directory that serves it. */
export function servedSiblingVariables(config: Pick<CockpitConfig, 'sibling'>, served: ReadonlyMap<string, ServedSibling>): Readonly<Record<string, string>> {
    return Object.fromEntries(config.sibling.map(sibling => [sibling.var, servedPath(served, sibling.slug)]))
}

// `stderr` is Git's own text, kept for classifying the failure; it may carry a remote URL's
// credentials, so callers print `detail` and never `stderr`.
type GitRun = Readonly<{ kind: 'complete'; stdout: string }>
    | Readonly<{ kind: 'failed'; exitCode: number; code: string; detail: string; stderr: string }>

/**
 * `stdoutLimitBytes` replaces the default bound, which keeps only the tail of longer output, with a
 * hard one: output past it fails with EXECUTION_STDOUT_LIMIT instead of arriving in part.
 */
type GitRunOptions = Readonly<{ timeoutMs?: number; stdoutLimitBytes?: number }>

/** Runs one Git command in a checkout through the authenticated executor and returns its text. */
export interface GitRunner {
    readonly executable: ResolvedExecutable
    run(cwd: string, id: string, args: readonly string[], options?: GitRunOptions): Promise<GitRun>
}

// Global and system configuration can carry aliases, credential helpers and fsmonitor commands that
// run code; cockpit's Git children read only the repository's own configuration, as setup's clone does.
export async function createGitRunner(
    env: Readonly<Record<string, string | undefined>>,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<GitRunner | Readonly<{ unavailable: string }>> {
    const git = await resolveGitExecutable(env)
    if (git.state !== 'available') return { unavailable: git.reason }
    const executable = git.value
    const environment = gitEnvironment(env)
    return {
        executable,
        async run(cwd, id, args, { timeoutMs = 30_000, stdoutLimitBytes } = {}) {
            const step: ExecutionStep = {
                id, argv: [executable.canonicalPath, '-C', cwd, ...GIT_CHILD_CONFIG, ...args], argv0: executable.invocationPath,
                cwd, env: environment, timeoutMs, stdoutLimitBytes: stdoutLimitBytes ?? 65_536, stderrLimitBytes: 65_536,
                ...stdoutLimitBytes === undefined ? { outputOverflow: 'retain-tail' as const } : {},
                paths: [], ports: [], labels: { purpose: id }, expected: [],
                consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
                    argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
                filesystemChecks: [], compensation: [],
            }
            const outcome = authenticatedExecutionOutcome(await execute(step), step)
            if (!outcome) return { kind: 'failed', exitCode: -1, code: 'unauthenticated', detail: 'the execution outcome could not be authenticated', stderr: '' }
            const text = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim()
            if (outcome.kind === 'complete') return { kind: 'complete', stdout: text(outcome.stdout) }
            // Git's last line names the cause (an unreachable host, a file a merge would overwrite); a
            // remote URL in it may carry credentials, and a line that cannot be redacted is withheld.
            const line = text(outcome.stderr).replace(/(\w+:\/\/)[^/@\s]+@/g, '$1[redacted]@').split('\n').filter(Boolean).at(-1)
            const cause = line === undefined ? undefined : redactSensitiveMessage(line.slice(0, 240))
            return { kind: 'failed', exitCode: outcome.execution.exitCode, code: outcome.code,
                detail: cause ? `${outcome.code}: ${cause}` : outcome.code, stderr: text(outcome.stderr) }
        },
    }
}

interface CheckoutIdentity {
    readonly toplevel: string
    readonly commonDirectory: string
    readonly origin: RepositoryIdentity | undefined
}

async function checkoutIdentity(git: GitRunner, directory: string): Promise<CheckoutIdentity | Readonly<{ reason: string }>> {
    const located = await git.run(directory, 'checkout:identity', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
    if (located.kind !== 'complete') return { reason: `it is not a Git checkout (${located.detail})` }
    const [toplevel, commonDirectory] = located.stdout.split('\n')
    if (!toplevel || !commonDirectory) return { reason: 'Git did not name its working tree and object store' }
    const origin = await git.run(directory, 'checkout:origin', ['config', '--get', 'remote.origin.url'])
    const identity = origin.kind === 'complete' ? repositoryIdentity(origin.stdout) : undefined
    try {
        return {
            toplevel: await realpath(toplevel), commonDirectory: await realpath(commonDirectory),
            origin: identity?.kind === 'known' ? identity.identity : undefined,
        }
    } catch (error) {
        return { reason: `the working tree or object store Git named cannot be resolved (${errorCause(error)})` }
    }
}

function sameIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
    return left.host === right.host && left.owner.toLowerCase() === right.owner.toLowerCase()
        && left.repository.toLowerCase() === right.repository.toLowerCase()
}

function spelled(identity: RepositoryIdentity | undefined): string {
    return identity === undefined ? 'no recognisable origin remote' : `${identity.host}/${identity.owner}/${identity.repository}`
}

type SiblingCheckoutInspection =
    | Readonly<{ kind: 'same-repository'; directory: string; evidence: 'object-store' | 'remote' }>
    | Readonly<{ kind: 'refusal'; diagnostic: EnvironmentDiagnostic }>

/**
 * Whether `candidate` is the root of a checkout of the sibling's repository: it shares the declared
 * checkout's object store (a linked worktree), or its origin names the same repository as the
 * declared checkout's origin or the declared remote. Anything else is refused: serving an unrelated
 * repository under a sibling's name would hand its code the sibling's mounts and grants.
 */
export async function inspectSiblingCheckout(input: Readonly<{
    sibling: Pick<Sibling, 'slug' | 'remote'>
    declared: string
    candidate: string
    git: GitRunner
}>): Promise<SiblingCheckoutInspection> {
    const unavailable = (message: string, fix: string): SiblingCheckoutInspection => ({ kind: 'refusal', diagnostic: {
        severity: 'error', code: 'SIBLING_CHECKOUT_UNAVAILABLE' satisfies typeof ENVIRONMENT_CODES.SIBLING_CHECKOUT_UNAVAILABLE,
        message, target: input.candidate, fix,
    } })
    const listWorktrees = `list the checkouts of ${input.sibling.slug} with git -C ${input.declared} worktree list, and name one of them`
    let directory: string
    try {
        directory = await realpath(input.candidate)
        if (!(await lstat(directory)).isDirectory()) return unavailable(`${input.candidate} is not a directory`, listWorktrees)
    } catch (error) {
        return unavailable(`${input.candidate} cannot be resolved (${errorCause(error)})`, listWorktrees)
    }
    // The guard admits an agent's `use` by the path as written; a link in it, swapped in after that
    // check, would record and then grant a directory the agent was never allowed to reach.
    if (directory !== input.candidate) {
        return unavailable(`${input.candidate} reaches ${directory} through a symbolic link, so cockpit will not record it`,
            `name the directory itself: ${cockpitCommand('use', { operand: input.sibling.slug, args: formatShellCommand([directory]) })}`)
    }
    const [candidate, declared] = await Promise.all([checkoutIdentity(input.git, directory), checkoutIdentity(input.git, input.declared)])
    if ('reason' in candidate) return unavailable(`${directory} cannot serve sibling ${input.sibling.slug}: ${candidate.reason}`, listWorktrees)
    if (candidate.toplevel !== directory) {
        return unavailable(`${directory} is inside the checkout at ${candidate.toplevel}, not its root, so the stack would mount part of a checkout`,
            `name the checkout's root: ${cockpitCommand('use', { operand: input.sibling.slug, args: formatShellCommand([candidate.toplevel]) })}`)
    }
    if (!('reason' in declared) && declared.commonDirectory === candidate.commonDirectory) {
        return { kind: 'same-repository', directory, evidence: 'object-store' }
    }
    // The declared checkout may track a fork while cockpit.toml's remote names the upstream; either counts.
    const declaredRemote = input.sibling.remote === undefined ? undefined : repositoryIdentity(input.sibling.remote)
    const expected = [...!('reason' in declared) && declared.origin !== undefined ? [declared.origin] : [],
        ...declaredRemote?.kind === 'known' ? [declaredRemote.identity] : []]
    if (candidate.origin !== undefined && expected.some(identity => sameIdentity(identity, candidate.origin!))) {
        return { kind: 'same-repository', directory, evidence: 'remote' }
    }
    return { kind: 'refusal', diagnostic: {
        severity: 'error', code: 'SIBLING_CHECKOUT_FOREIGN' satisfies typeof ENVIRONMENT_CODES.SIBLING_CHECKOUT_FOREIGN,
        message: `${directory} is not a checkout of sibling ${input.sibling.slug}: it shares no object store with ${input.declared}, `
            + `and its origin (${spelled(candidate.origin)}) is not the sibling's (${expected.length === 0 ? 'none known' : expected.map(spelled).join(' or ')})`,
        target: input.candidate,
        fix: `create a worktree of the sibling with git -C ${input.declared} worktree add <path> <branch> and name that path, or ${listWorktrees}`,
    } }
}

/** The declared environment files the served checkout lacks; a fresh worktree has none of the ignored ones. */
export async function missingEnvironmentFiles(served: ServedSibling, sibling: Pick<Sibling, 'environment_files'>): Promise<readonly Readonly<{ template: string; instance: string }>[]> {
    const present = await Promise.all((sibling.environment_files ?? []).map(async file => await lstatIfPresent(join(served.served, file.instance)) !== undefined))
    return (sibling.environment_files ?? []).filter((_, index) => !present[index]).map(file => ({ template: file.template, instance: file.instance }))
}

/** One warning per environment file an overriding checkout lacks, naming who must create it and from what. */
export function missingEnvironmentFileDiagnostics(served: ServedSibling,
    missing: readonly Readonly<{ template: string; instance: string }>[]): readonly EnvironmentDiagnostic[] {
    return missing.map(file => ({
        severity: 'warning' as const,
        code: 'SIBLING_ENVIRONMENT_FILE_MISSING' satisfies typeof ENVIRONMENT_CODES.SIBLING_ENVIRONMENT_FILE_MISSING,
        message: `sibling ${served.slug} is served from ${served.served}, which has no ${file.instance}; the services that read it would start without its settings`,
        target: join(served.served, file.instance),
        fix: `a person creates ${join(served.served, file.instance)} from the template ${join(served.served, file.template)}, or copies the one in ${served.declared}; cockpit never copies environment files between checkouts`,
    }))
}
