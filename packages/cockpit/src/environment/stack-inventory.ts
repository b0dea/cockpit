/**
 * Observes every stack this machine's cockpit state or the local Docker daemon knows about, whichever
 * cockpit and checkout started it, and decides which ones lost their checkout. A deleted worktree
 * leaves its stack, volumes, network and port lease behind with no checkout left to run `down` from;
 * this is where they are found. `cockpit stacks` lists them (`stack-inventory-report.ts`), `cockpit
 * stacks prune` removes them (`stack-inventory-prune.ts`), and doctor reads the summary at the end.
 *
 * A stack's checkout is never guessed from a name. It is proven one of two ways: Compose labels each
 * container with the directory it ran from, and the ancestor whose checkout identity derives the
 * stack's own identity is the checkout; or the cockpit's main checkout is known, and none of the
 * checkouts Git records for it derives the stack. Anything not proven is kept.
 *
 * None of these modules spawns a process: Docker steps cross the supplied `execute`, which production
 * binds to `environment-exec/execute.ts`. State files are read and removed only through `state.ts`.
 */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { readBoundedFile } from '../bounded-read.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { decodeCoordinationRecord, type CoordinationRecord } from './claims.js'
import { ENVIRONMENT_CODES, errorCause, hasErrorCode, type CockpitId, type EnvironmentDiagnostic, type StackId } from './contract.js'
import { checkoutId as deriveCheckoutId, cockpitId as deriveCockpitId, composeProjectName, stackId as deriveStackId } from './identity.js'
import type { MachineStackDiscovery, MachineStackResource } from './reclaim.js'
import {
    inspectStackRecords,
    inspectStateNamespaceFolder,
    withStateNamespaceInventory,
    type StackStateFile,
    type StateNamespace,
} from './state.js'

type CheckoutStatus = 'present' | 'replaced' | 'missing' | 'unknown'
type StackVerdict = 'current' | 'kept' | 'orphaned'

export interface StackCheckout {
    readonly path: string | null
    readonly status: CheckoutStatus
    /** Where the path, or the proof that no checkout exists, was read from. */
    readonly source: string
}

export interface StackRow {
    readonly cockpitId: CockpitId
    readonly stackId: StackId
    readonly composeProject: string
    readonly checkout: StackCheckout
    readonly state: Readonly<{ status: 'readable' | 'malformed' | 'absent'; path: string | null; reason?: string; holders: number; draining: boolean }>
    readonly containers: Readonly<{ running: readonly string[]; stopped: readonly string[] }>
    readonly networks: readonly string[]
    readonly volumes: readonly string[]
    /** The port lease the stack still holds, by `[ports.bases]` name; null once released. */
    readonly ports: Readonly<Record<string, number>> | null
    readonly lastActivity: Readonly<{ at: string; source: 'state record' | 'state file modification time' }> | null
    readonly verdict: StackVerdict
    readonly reason: string
}

/** Another cockpit's state folder this version cannot read. */
interface StateFolderRow {
    readonly path: string
    readonly cockpitId: CockpitId | null
    readonly reason: string
    readonly verdict: 'kept' | 'orphaned'
    readonly why: string
}

interface MachineStackInventory {
    readonly stacks: readonly StackRow[]
    readonly stateFolders: readonly StateFolderRow[]
    /** Docker resources with the stack label whose other ownership labels are missing or malformed. */
    readonly unattributedResources: number
}

export interface ObservedStack {
    readonly row: StackRow
    readonly namespace: StateNamespace | undefined
    readonly files: readonly StackStateFile[]
    readonly resources: readonly MachineStackResource[]
}

export interface Observation {
    readonly selection: MachineStackDiscovery['selection'] | undefined
    readonly inventory: MachineStackInventory
    readonly stacks: readonly ObservedStack[]
    readonly folders: readonly Readonly<{ row: StateFolderRow; fingerprint: string | undefined }>[]
}

export interface OwnCheckout {
    readonly cockpitId: CockpitId
    readonly stackId: StackId
    readonly mainCheckoutPath: string
}

export type Refusal = Readonly<{ kind: 'refusal'; diagnostics: readonly EnvironmentDiagnostic[] }>

const COCKPIT_ID = /^cockpit:([a-z0-9][a-z0-9-]*):[a-f0-9]{64}$/
const STACK_FILE = /^stack_([a-f0-9]{64})\.json$/
const RECORD_KINDS = ['coordination', 'lifecycle', 'lifecycle-history', 'data-outcome'] as const
const GIT_POINTER_BYTES = 4_096
const WORKTREE_LIMIT = 4_096

export function refuse(code: EnvironmentDiagnostic['code'], message: string, target: string, fix?: string): Refusal {
    return { kind: 'refusal', diagnostics: [{ severity: 'error', code, message, target, ...(fix ? { fix } : {}) }] }
}

// A path that cannot exist (ENOENT, or a parent that is now a file) is absent; anything else that
// stops a read is not proof of absence, and is left to the caller as unknown.
async function statOf(path: string): Promise<Awaited<ReturnType<typeof lstat>> | 'absent' | 'unreadable'> {
    try { return await lstat(path) }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return 'absent'
        if (hasErrorCode(error, 'EACCES', 'EPERM', 'ELOOP')) return 'unreadable'
        throw error
    }
}

function readPointer(path: string): string | undefined {
    try {
        const read = readBoundedFile(path, GIT_POINTER_BYTES)
        return read.kind === 'complete' ? read.bytes.toString('utf8').trim() : undefined
    } catch (error) {
        // Absent, not a regular file, a symbolic link or unreadable: no pointer Git would follow.
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EACCES', 'EPERM')) return undefined
        throw error
    }
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
    if (result.status === 'rejected') throw result.reason
    return result.value
}

async function canonical(path: string): Promise<string | undefined> {
    try { return await realpath(path) }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP')) return undefined
        throw error
    }
}

/** The main checkout a checkout belongs to, read from its `.git` entry as Git lays it out. */
async function mainCheckoutOf(checkout: string): Promise<string | undefined> {
    const dotGit = await statOf(join(checkout, '.git'))
    if (typeof dotGit === 'string') return undefined
    if (dotGit.isDirectory()) return canonical(checkout)
    const pointer = /^gitdir: (.+)$/m.exec(readPointer(join(checkout, '.git')) ?? '')
    if (!pointer) return undefined
    const gitDirectory = resolve(checkout, pointer[1]!.trim())
    const common = readPointer(join(gitDirectory, 'commondir'))
    if (common === undefined) return undefined
    const commonDirectory = resolve(gitDirectory, common)
    return basename(commonDirectory) === '.git' ? canonical(dirname(commonDirectory)) : undefined
}

/**
 * A checkout Git records. `missing` marks a registered worktree whose path does not exist now: Git keeps
 * the registration until `git worktree prune` drops it, and never drops a locked one, so an unmounted
 * drive or share, or a checkout moved without `git worktree repair`, reads exactly like this.
 */
interface RecordedCheckout {
    readonly path: string
    readonly missing?: 'locked' | 'registered'
}

/**
 * The main checkout and every worktree Git records for it, or undefined when any registration cannot
 * be read: an incomplete list would make a live worktree's stack look orphaned.
 */
async function checkoutsOf(main: string): Promise<readonly RecordedCheckout[] | undefined> {
    const registry = join(main, '.git', 'worktrees')
    let names: string[]
    try { names = await readdir(registry) }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [{ path: main }]
        if (hasErrorCode(error, 'ENOTDIR', 'EACCES', 'EPERM')) return undefined
        throw error
    }
    if (names.length > WORKTREE_LIMIT) return undefined
    // Every registration is read at once; walking the results in name order keeps the outcome a
    // sequential walk would give, down to which failure, an unreadable entry or a throw, decides it.
    const registered = await Promise.allSettled(names.sort().map(async (name): Promise<RecordedCheckout | undefined> => {
        const pointer = readPointer(join(registry, name, 'gitdir'))
        if (pointer === undefined) return undefined
        const target = resolve(registry, name, pointer)
        if (basename(target) !== '.git') return undefined
        const status = await statOf(dirname(target))
        if (status === 'unreadable') return undefined
        if (status !== 'absent') {
            const path = await canonical(dirname(target))
            return path === undefined ? undefined : { path }
        }
        const locked = await statOf(join(registry, name, 'locked'))
        if (locked === 'unreadable') return undefined
        return { path: dirname(target), missing: locked === 'absent' ? 'registered' : 'locked' }
    }))
    const checkouts: RecordedCheckout[] = [{ path: main }]
    for (const result of registered) {
        const checkout = settledValue(result)
        if (checkout === undefined) return undefined
        checkouts.push(checkout)
    }
    return checkouts
}

function derivesStack(cockpitId: CockpitId, stackId: StackId, path: string): boolean {
    return sharedStackOf(cockpitId, deriveCheckoutId({ checkoutPath: path })) === stackId
}

function sharedStackOf(cockpitId: CockpitId, checkoutId: ReturnType<typeof deriveCheckoutId>): StackId {
    return deriveStackId({ cockpitId, checkoutId, variant: { kind: 'shared' } })
}

/** The ancestor of a Compose working directory whose checkout identity derives this stack's identity. */
function provenCheckout(cockpitId: CockpitId, stackId: StackId, workingDir: string): string | undefined {
    for (let cursor = workingDir; ; cursor = dirname(cursor)) {
        if (derivesStack(cockpitId, stackId, cursor)) return cursor
        if (dirname(cursor) === cursor) return undefined
    }
}

function cockpitNameOf(cockpitId: CockpitId): string {
    return COCKPIT_ID.exec(cockpitId)![1]!
}

async function statusOf(path: string, cockpitId: CockpitId): Promise<CheckoutStatus> {
    const status = await statOf(path)
    if (status === 'absent') return 'missing'
    if (status === 'unreadable') return 'unknown'
    if (!status.isDirectory()) return 'replaced'
    const main = await mainCheckoutOf(path)
    return main !== undefined && deriveCockpitId({ name: cockpitNameOf(cockpitId), mainCheckoutPath: main }) === cockpitId ? 'present' : 'replaced'
}

function namespaceCockpitId(path: string): CockpitId | null {
    // Earlier builds spelled the folder with colons; both spellings name the same identity.
    const id = basename(path).replaceAll('_', ':')
    return COCKPIT_ID.test(id) ? id as CockpitId : null
}

async function stackIdsIn(namespace: StateNamespace): Promise<readonly StackId[]> {
    const found = new Set<StackId>()
    for (const kind of RECORD_KINDS) {
        let names: string[]
        try { names = await readdir(join(namespace.cockpitRoot, 'records', kind)) }
        catch (error) {
            if (hasErrorCode(error, 'ENOENT')) continue
            throw error
        }
        for (const name of names) {
            const match = STACK_FILE.exec(name)
            if (match) found.add(`stack:${match[1]}` as StackId)
        }
    }
    return [...found].sort()
}

interface StateStack {
    readonly cockpitId: CockpitId
    readonly stackId: StackId
    readonly namespace: StateNamespace
    readonly files: readonly StackStateFile[]
    readonly record: CoordinationRecord | undefined
    readonly malformed: string | undefined
    readonly coordinationPath: string
    readonly updatedAt: string | undefined
    readonly modifiedAt: string | undefined
}

async function readStateStacks(namespace: StateNamespace): Promise<
    Readonly<{ stacks: readonly StateStack[]; skipped: readonly Readonly<{ path: string; reason: string }>[] }> | Refusal> {
    const read = await withStateNamespaceInventory(namespace, async (namespaces, skipped) => {
        const readStack = async (candidate: StateNamespace, stackId: StackId): Promise<StateStack> => {
            const cockpitId = candidate.paths.coordination(stackId).cockpitId
            const coordinationPath = candidate.paths.coordination(stackId).path
            const records = await inspectStackRecords(candidate, stackId)
            const stored = records.kind === 'complete' ? records.value.coordination : undefined
            const record = stored?.kind === 'complete' ? decodeCoordinationRecord(stored.value, stackId) : undefined
            const malformed = records.kind !== 'complete' ? records.kind === 'missing' ? 'its state disappeared during observation' : records.message
                : stored?.kind === 'refusal' || stored?.kind === 'indeterminate' ? stored.message
                    : stored?.kind === 'complete' && record === undefined ? 'the coordination record does not match the format this version reads' : undefined
            const status = malformed === undefined ? undefined : await statOf(coordinationPath)
            return {
                cockpitId, stackId, namespace: candidate, coordinationPath, record, malformed,
                files: records.kind === 'complete' ? records.value.files : [],
                updatedAt: stored?.kind === 'complete' && record !== undefined ? stored.value.updatedAt : undefined,
                modifiedAt: status !== undefined && typeof status !== 'string' ? status.mtime.toISOString() : undefined,
            }
        }
        const perNamespace = await Promise.all(namespaces.map(async (candidate) =>
            Promise.all((await stackIdsIn(candidate)).map((stackId) => readStack(candidate, stackId)))))
        return { stacks: perNamespace.flat(), skipped }
    })
    if (read.kind === 'complete') return read.value
    if (read.kind === 'missing') return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'the state root disappeared during observation', read.path)
    return refuse(read.code, read.message, read.target, read.recovery)
}

function verdictOf(input: Readonly<{ current: boolean; checkout: StackCheckout; malformed: boolean; draining: boolean; registered: RecordedCheckout['missing'] }>): { verdict: StackVerdict; reason: string } {
    if (input.current) return { verdict: 'current', reason: 'this is the stack of the checkout running the command' }
    if (input.draining) return { verdict: 'kept', reason: 'a down or reset of this stack is in progress, and only its own checkout may finish it' }
    if (input.registered === 'locked') return { verdict: 'kept', reason: 'Git marks its worktree locked, as for one on a drive or share that is not mounted now; once the checkout is really gone, run git worktree unlock and git worktree prune in its main checkout' }
    if (input.registered === 'registered') return { verdict: 'kept', reason: 'its checkout path does not exist but Git still registers the worktree, as for one on a drive or share that is not mounted now or one moved without git worktree repair; once the checkout is really gone, run git worktree prune in its main checkout' }
    if (input.checkout.status === 'present') return { verdict: 'kept', reason: 'its checkout exists' }
    if (input.checkout.status === 'replaced') return { verdict: 'kept', reason: 'its checkout path exists but is no longer a checkout of this cockpit; cockpit cannot prove nothing uses the stack' }
    if (input.checkout.status === 'missing') return { verdict: 'orphaned', reason: 'its checkout no longer exists' }
    // State this version cannot read may be a newer version's, for a checkout that still exists and
    // a stack that is only down; nothing running proves nothing about its checkout.
    return input.malformed
        ? { verdict: 'kept', reason: 'its state cannot be read by this cockpit version and no checkout is proven gone; prune it from a cockpit version that reads it, or once its checkout is gone' }
        : { verdict: 'kept', reason: 'cockpit cannot tell where its checkout is, so it may still be in use' }
}

/**
 * Joins the state root's records with what the daemon lists, and decides each stack's checkout and
 * verdict. Without `discovery` it reads state and checkouts only, as doctor does, and calls no
 * unreadable state folder orphaned.
 */
export async function observeMachineStacks(input: Readonly<{
    namespace: StateNamespace
    own: OwnCheckout
    discovery?: MachineStackDiscovery
}>): Promise<Observation | Refusal> {
    // A read that fails in an unexpected way leaves the inventory unknown: a named refusal, which
    // doctor reports as a warning, rather than a throw that ends the command.
    try { return await observe(input) }
    catch (error) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, `this machine's stacks could not be observed safely: ${errorCause(error)}`,
            dirname(input.namespace.cockpitRoot), 'inspect the named state entry or checkout, then retry')
    }
}

async function observe(input: Parameters<typeof observeMachineStacks>[0]): Promise<Observation | Refusal> {
    const state = await readStateStacks(input.namespace)
    if ('kind' in state) return state
    const key = (cockpitId: string, stackId: string) => `${cockpitId}\0${stackId}`
    const resources = new Map<string, MachineStackResource[]>()
    for (const resource of input.discovery?.resources ?? []) {
        const id = key(resource.cockpitId, resource.stackId)
        resources.set(id, [...resources.get(id) ?? [], resource])
    }
    const stateByKey = new Map(state.stacks.map((stack) => [key(stack.cockpitId, stack.stackId), stack]))
    const skippedByCockpit = new Map(state.skipped.flatMap((folder) => {
        const cockpitId = namespaceCockpitId(folder.path)
        return cockpitId === null ? [] : [[cockpitId, folder] as const]
    }))
    const keys = [...new Set([...stateByKey.keys(), ...resources.keys()])].sort()
    const identities = keys.map((id) => {
        const [cockpitId, stackId] = id.split('\0') as [CockpitId, StackId]
        return { id, cockpitId, stackId }
    })

    // A main checkout is known for this cockpit, and for any cockpit with a proven present checkout.
    const proofs = new Map<string, string>()
    for (const { id, cockpitId, stackId } of identities) {
        for (const resource of resources.get(id) ?? []) {
            const proven = resource.workingDir === null ? undefined : provenCheckout(cockpitId, stackId, resource.workingDir)
            if (proven !== undefined) { proofs.set(id, proven); break }
        }
    }
    const mains = new Map<CockpitId, string>([[input.own.cockpitId, input.own.mainCheckoutPath]])
    // Each proven checkout's main checkout is read at once; the first, in identity order, that
    // derives its cockpit decides, and a read a sequential walk would have skipped cannot fail it.
    const candidates = identities.flatMap(({ id, cockpitId }) => {
        const proven = proofs.get(id)
        return proven === undefined || cockpitId === input.own.cockpitId ? [] : [{ cockpitId, proven }]
    })
    const candidateMains = await Promise.allSettled(candidates.map(({ proven }) => mainCheckoutOf(proven)))
    for (const [index, { cockpitId }] of candidates.entries()) {
        if (mains.has(cockpitId)) continue
        const main = settledValue(candidateMains[index]!)
        if (main !== undefined && deriveCockpitId({ name: cockpitNameOf(cockpitId), mainCheckoutPath: main }) === cockpitId) mains.set(cockpitId, main)
    }
    // Every checkout a cockpit records, with the checkout and shared stack identity it derives, computed once per path.
    const checkouts = new Map(await Promise.all([...mains].map(async ([cockpitId, main]) => {
        const paths = await checkoutsOf(main)
        return [cockpitId, paths?.map((recorded) => {
            const checkoutId = deriveCheckoutId({ checkoutPath: recorded.path })
            return { ...recorded, checkoutId, stackId: sharedStackOf(cockpitId, checkoutId) }
        })] as const
    })))

    const stacks: ObservedStack[] = []
    for (const { id, cockpitId, stackId } of identities) {
        const stored = stateByKey.get(id)
        const owned = resources.get(id) ?? []
        const known = checkouts.get(cockpitId)
        // A holder names its checkout's identity outright; the derivation covers a stack no one holds.
        const holders = new Set(stored?.record?.holders.map(({ checkoutId: id }) => id) ?? [])
        const registered = known?.find((checkout) => checkout.stackId === stackId || holders.has(checkout.checkoutId))
        const proven = proofs.get(id)
        const checkout: StackCheckout = registered !== undefined
            ? registered.missing === undefined
                ? { path: registered.path, status: 'present', source: `a checkout Git records for ${mains.get(cockpitId)}` }
                : { path: registered.path, status: 'unknown',
                    source: `a worktree Git ${registered.missing === 'locked' ? 'marks locked' : 'still registers'} for ${mains.get(cockpitId)}, at a path that does not exist now` }
            : proven !== undefined
                ? { path: proven, status: await statusOf(proven, cockpitId), source: `the Compose working directory label of container ${owned.find((row) => row.workingDir !== null)!.name}` }
                : known !== undefined
                    ? { path: null, status: 'missing', source: `none of the checkouts Git records for ${mains.get(cockpitId)} is this stack's` }
                    : { path: null, status: 'unknown', source: 'no container of this stack records where it ran, and no checkout of its cockpit was found' }
        const folder = skippedByCockpit.get(cockpitId)
        const malformed = stored?.malformed ?? (folder ? `its cockpit's state folder cannot be read: ${folder.reason}` : undefined)
        const containers = owned.filter(({ kind }) => kind === 'container')
        const record = stored?.record
        const draining = record?.drain != null
        const decided = verdictOf({ current: cockpitId === input.own.cockpitId && stackId === input.own.stackId, checkout,
            malformed: malformed !== undefined, draining, registered: registered?.missing })
        const lease = record?.lease && !record.lease.released ? record.lease.ports : null
        stacks.push({
            namespace: stored?.namespace, files: stored?.files ?? [], resources: owned,
            row: {
                cockpitId, stackId,
                composeProject: owned.find(({ composeProject }) => composeProject !== null)?.composeProject
                    ?? composeProjectName({ cockpitName: cockpitNameOf(cockpitId), stackId }),
                checkout,
                state: {
                    status: stored === undefined && folder === undefined ? 'absent' : malformed !== undefined ? 'malformed' : 'readable',
                    path: stored?.coordinationPath ?? folder?.path ?? null,
                    ...(malformed === undefined ? {} : { reason: malformed }),
                    holders: record?.holders.length ?? 0, draining,
                },
                containers: {
                    running: containers.filter(({ running }) => running).map(({ name }) => name),
                    stopped: containers.filter(({ running }) => !running).map(({ name }) => name),
                },
                networks: owned.filter(({ kind }) => kind === 'network').map(({ name }) => name),
                volumes: owned.filter(({ kind }) => kind === 'volume').map(({ name }) => name),
                ports: lease === null ? null : { ...lease },
                lastActivity: stored?.updatedAt !== undefined ? { at: stored.updatedAt, source: 'state record' }
                    : stored?.modifiedAt !== undefined ? { at: stored.modifiedAt, source: 'state file modification time' } : null,
                ...decided,
            },
        })
    }

    const folders = await Promise.all(state.skipped.map(async (folder): Promise<Observation['folders'][number]> => {
        const cockpitId = namespaceCockpitId(folder.path)
        const live = stacks.find(({ row }) => row.cockpitId === cockpitId && row.verdict !== 'orphaned')
        // Only a prune, which consults Docker, can remove a folder, so only it needs the folder's fingerprint.
        const fingerprint = input.discovery === undefined ? undefined : await inspectStateNamespaceFolder(input.namespace, folder.path)
        // Only the colon spelling an earlier build used is provably no current build's: a folder in the
        // current spelling that this version cannot read may belong to a newer version still in use.
        const legacy = basename(folder.path).includes(':')
        const why = cockpitId === null ? 'its name is not a cockpit identity, so Docker cannot show which stacks it holds'
            : !legacy ? 'it is named as current cockpit versions name their state, so a newer version may still use it; prune it from a version that reads it'
                : fingerprint === undefined ? 'Docker was not consulted to show that none of its stacks is in use'
                    : live !== undefined ? `its stack ${live.row.stackId} is kept: ${live.row.reason}`
                        : fingerprint.kind !== 'complete' ? `it cannot be inspected safely: ${fingerprint.kind === 'refusal' ? fingerprint.message : 'it disappeared'}`
                            : 'an earlier cockpit build wrote it, no current version reads it, and none of its stacks is in use'
        const orphaned = cockpitId !== null && legacy && live === undefined && fingerprint?.kind === 'complete'
        return {
            row: { path: folder.path, cockpitId, reason: folder.reason, verdict: orphaned ? 'orphaned' : 'kept', why },
            fingerprint: fingerprint?.kind === 'complete' ? fingerprint.value : undefined,
        }
    }))
    return {
        selection: input.discovery?.selection,
        inventory: { stacks: stacks.map(({ row }) => row), stateFolders: folders.map(({ row }) => row), unattributedResources: input.discovery?.unattributed ?? 0 },
        stacks, folders,
    }
}

/** What doctor reads of this machine's stacks in one walk of the state namespace. */
type DoctorMachineState =
    | Readonly<{
        kind: 'complete'
        /** A STACKS_ORPHANED warning when stacks of this machine have a checkout that is gone or state this version cannot read. */
        orphanedStacks: readonly EnvironmentDiagnostic[]
    }>
    | Refusal

/**
 * Doctor's view of the machine's stacks without asking Docker: stacks whose checkout is gone and
 * state this version cannot read. The full inventory is `cockpit stacks`.
 */
async function inspectMachineStateForDoctor(input: Readonly<{ namespace: StateNamespace; own: OwnCheckout; configPath: string }>): Promise<DoctorMachineState> {
    const observed = await observeMachineStacks({ namespace: input.namespace, own: input.own })
    if ('kind' in observed) return observed
    const gone = observed.inventory.stacks.filter(({ checkout }) => checkout.status === 'missing')
    // Other cockpits' unreadable state folders have doctor's own warning; these are unreadable records.
    const unreadable = observed.inventory.stacks.filter(({ state }) => state.status === 'malformed' && state.path !== null
        && !observed.inventory.stateFolders.some(({ path }) => path === state.path)).length
    if (gone.length + unreadable === 0) return { kind: 'complete', orphanedStacks: [] }
    const parts = [
        ...gone.length > 0 ? [`${gone.length} whose checkout no longer exists`] : [],
        ...unreadable > 0 ? [`${unreadable} whose state this cockpit version cannot read`] : [],
    ]
    return { kind: 'complete', orphanedStacks: [{ severity: 'warning', target: dirname(input.namespace.cockpitRoot),
        code: 'STACKS_ORPHANED' as const satisfies typeof ENVIRONMENT_CODES.STACKS_ORPHANED,
        message: `this machine has stacks that no checkout can reach (${parts.join('; ')}); they keep their containers, volumes, port leases and state`,
        fix: `list them with ${cockpitCommand('stacks', { config: input.configPath })}, preview the removal with ${cockpitCommand('stacks prune', { config: input.configPath })}, then apply it with --apply` }] }
}

/** The orphaned-stack warnings of `inspectMachineStateForDoctor`, with a state that cannot be read reported as a warning. */
export async function inspectMachineStacksForDoctor(input: Readonly<{ namespace: StateNamespace; own: OwnCheckout; configPath: string }>): Promise<readonly EnvironmentDiagnostic[]> {
    const state = await inspectMachineStateForDoctor(input)
    return state.kind === 'complete' ? state.orphanedStacks : state.diagnostics.map((diagnostic) => ({ ...diagnostic, severity: 'warning' as const,
        message: `doctor could not read this machine's cockpit state, so it did not look for orphaned stacks: ${diagnostic.message}` }))
}
