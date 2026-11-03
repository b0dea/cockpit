import { hasErrorCode } from './contract.js'
/**
 * Owns the leftovers of a `runtime measure` that was killed before the probe could clean up: the
 * probe's containers, network and volume on the daemon, and the private `cockpit-runtime-measure-*`
 * directory in the temp directory. The next measure removes what it can prove belongs to a dead
 * measure of this cockpit and says what it removed; whatever it cannot prove dead it leaves and
 * names. It never spawns a process itself: every Docker call crosses the supplied `run`, and liveness crosses `observe`.
 */
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isProcessGone, isProcessStart, type ProcessStartObservation } from './claims.js'

export const mechanism = {
    id: 'runtime-probe-residue',
    module: 'packages/cockpit/src/environment/runtime-probe-residue.ts',
    exports: ['MEASURE_DIRECTORY_PREFIX', 'PROBE_OWNER_LABEL', 'isProbeOwner', 'claimMeasureDirectory', 'sweepProbeResidue'],
} as const

export const MEASURE_DIRECTORY_PREFIX = 'cockpit-runtime-measure-'
const OWNER_FILE = 'owner'
// A directory with no owner file was killed between creation and its first write, or is being
// created right now; only age tells them apart, and a probe never outlives its five-minute window.
const UNOWNED_STALE_MS = 10 * 60_000
const PROBE_LABEL = 'dev.b0dea.cockpit.probe'
/** Names the measure process that created a probe resource, as `<pid>` or `<pid>@<start identity>`. */
export const PROBE_OWNER_LABEL = 'dev.b0dea.cockpit.probe-owner'
const OWNER = /^([1-9][0-9]{0,9})(?:@(\S+))?$/
const DOCKER_ID = /^[a-f0-9]{12,64}$/
const DOCKER_NAME = /^[a-z0-9][a-z0-9_.-]{0,200}$/

/** Run one Docker read or removal; `failed` carries the first line of Docker's complaint. */
export type ResidueRunner = (id: string, args: readonly string[]) => Promise<Readonly<{ kind: 'complete'; text: string }> | Readonly<{ kind: 'failed'; detail: string }>>

/** Observe a process's presence and start identity, as `observeProcessStart` does. */
export type ProcessObserver = (pid: number) => Promise<ProcessStartObservation>

export type ProbeResidueOutcome =
    | Readonly<{ kind: 'complete'; removed: readonly string[]; left: readonly string[] }>
    | Readonly<{ kind: 'refusal'; reason: string; removed: readonly string[] }>

/** Mark a freshly created measure directory as owned by `owner` (see `PROBE_OWNER_LABEL`), so a later measure can tell it is alive. */
export async function claimMeasureDirectory(directory: string, owner: string): Promise<void> {
    await writeFile(join(directory, OWNER_FILE), `${owner}\n`, { mode: 0o600 })
}

export function isProbeOwner(owner: string): boolean {
    const match = OWNER.exec(owner)
    return match !== null && Number(match[1]) <= 2_147_483_647 && (match[2] === undefined || isProcessStart(match[2]))
}

// Only proof that the owner is gone marks it dead: a missing or malformed owner, a reused pid or a
// failed check keeps what it owns.
async function ownerGone(owner: string, observe: ProcessObserver): Promise<boolean> {
    if (!isProbeOwner(owner)) return false
    const [, pid, start] = OWNER.exec(owner)!
    return isProcessGone(start, await observe(Number(pid)))
}

type MeasureDirectory = Readonly<{ path: string; alive: boolean }>

async function measureDirectories(temporaryDirectory: string, uid: number | undefined, observe: ProcessObserver): Promise<MeasureDirectory[]> {
    const found: MeasureDirectory[] = []
    for (const name of await readdir(temporaryDirectory)) {
        if (!new RegExp(`^${MEASURE_DIRECTORY_PREFIX}[A-Za-z0-9]{6}$`).test(name)) continue
        const path = join(temporaryDirectory, name)
        const status = await lstat(path)
        // Only a real directory of this user: a symlink or someone else's directory is not ours to judge or delete.
        if (!status.isDirectory() || status.isSymbolicLink() || (uid !== undefined && status.uid !== uid)) continue
        let owner: string | undefined
        try { owner = (await readFile(join(path, OWNER_FILE), 'utf8')).trim() } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error
        }
        const alive = owner === undefined ? Date.now() - status.mtimeMs < UNOWNED_STALE_MS : !await ownerGone(owner, observe)
        found.push(Object.freeze({ path, alive }))
    }
    return found
}

interface Found { readonly kind: 'container' | 'network' | 'volume'; readonly handle: string; readonly project: string; readonly batchLabel: string; readonly owner: string }

async function discover(run: ResidueRunner): Promise<Found[] | string> {
    const listings = [
        ['container', ['ps', '-a', '--no-trunc', '--filter', `label=${PROBE_LABEL}`, '--format', `{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "${PROBE_LABEL}"}}\t{{.Label "${PROBE_OWNER_LABEL}"}}`], DOCKER_ID],
        ['network', ['network', 'ls', '--no-trunc', '--filter', `label=${PROBE_LABEL}`, '--format', `{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "${PROBE_LABEL}"}}\t{{.Label "${PROBE_OWNER_LABEL}"}}`], DOCKER_ID],
        ['volume', ['volume', 'ls', '--filter', `label=${PROBE_LABEL}`, '--format', `{{.Name}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "${PROBE_LABEL}"}}\t{{.Label "${PROBE_OWNER_LABEL}"}}`], DOCKER_NAME],
    ] as const
    const found: Found[] = []
    for (const [kind, args, valid] of listings) {
        const listed = await run(`runtime:measure:residue:${kind}`, args)
        if (listed.kind !== 'complete') return `listing leftover probe ${kind}s failed (${listed.detail})`
        for (const line of listed.text.split('\n').filter(Boolean)) {
            const [handle = '', project = '', batchLabel = '', owner = ''] = line.split('\t')
            if (!valid.test(handle)) return `docker listed a probe ${kind} with an unexpected identity`
            found.push({ kind, handle, project, batchLabel, owner })
        }
    }
    return found
}

/**
 * Remove this cockpit's probe resources left by a dead measure. A resource is the probe's only if
 * it carries the probe label and a Compose project named `<projectPrefix>-probe-<batch>` (Compose
 * appends the stack hash) whose batch matches the label, so a different cockpit's probe, or any other stack, is never touched.
 * It is dead only when the measure its owner label names is provably gone. Liveness is read from
 * the label on the shared daemon, not from the temp directory: agent tools give each session its
 * own TMPDIR, so a concurrent measure's directory is invisible, and judging by it removed that
 * measure's running probe. Anything not provably dead may be running now and is only reported.
 */
export async function sweepProbeResidue(input: Readonly<{
    projectPrefix: string
    temporaryDirectory: string
    ownDirectory: string
    run: ResidueRunner
    observe: ProcessObserver
    uid?: number
}>): Promise<ProbeResidueOutcome> {
    const directories = (await measureDirectories(input.temporaryDirectory, input.uid, input.observe)).filter(({ path }) => path !== input.ownDirectory)
    const projectPattern = new RegExp(`^${input.projectPrefix.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}-probe-([0-9a-f]{32})(?:-[0-9a-f]{12})?$`)

    const discovered = await discover(input.run)
    if (typeof discovered === 'string') return { kind: 'refusal', reason: discovered, removed: [] }
    const removed: string[] = []
    const left: string[] = []
    const failed: string[] = []
    const owned = discovered.flatMap((item) => {
        const batch = projectPattern.exec(item.project)?.[1]
        // The probe's own label must agree with its project, so a resource merely named like one is not removed.
        return batch === undefined || batch !== item.batchLabel ? [] : [{ ...item, batch }]
    })
    const label = (item: Found) => `${item.kind} ${item.kind === 'volume' ? item.handle : item.handle.slice(0, 12)} (project ${item.project})`
    // One measure's containers, network and volume share an owner; observe it once.
    const gone = new Map<string, Promise<boolean>>()
    const doomed: typeof owned = []
    for (const item of owned) {
        if (!gone.has(item.owner)) gone.set(item.owner, ownerGone(item.owner, input.observe))
        if (await gone.get(item.owner)) doomed.push(item)
    }
    for (const item of owned) if (!doomed.includes(item)) left.push(label(item))
    // Containers first: a network or volume a container still uses cannot be removed.
    for (const kind of ['container', 'network', 'volume'] as const) {
        for (const item of doomed.filter((candidate) => candidate.kind === kind)) {
            const args = kind === 'container' ? ['container', 'rm', '--force', '--volumes', item.handle]
                : kind === 'network' ? ['network', 'rm', item.handle] : ['volume', 'rm', item.handle]
            const outcome = await input.run(`runtime:measure:residue:rm-${kind}`, args)
            if (outcome.kind === 'complete') removed.push(label(item))
            else failed.push(`${label(item)}: ${outcome.detail}`)
        }
    }
    if (failed.length > 0) {
        return { kind: 'refusal', removed, reason: `a leftover from an interrupted measure could not be removed: ${failed.join('; ')}; remove it, then measure again` }
    }
    for (const directory of directories) {
        if (directory.alive) continue
        await rm(directory.path, { recursive: true, force: true })
        removed.push(`temporary directory ${directory.path}`)
    }
    return { kind: 'complete', removed, left }
}
