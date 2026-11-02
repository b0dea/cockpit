/**
 * Owns the leftovers of a `runtime measure` that was killed before the probe could clean up: the
 * probe's containers, network and volume on the daemon, and the private `cockpit-runtime-measure-*`
 * directory in the temp directory. The next measure removes what it can prove belongs to a dead
 * measure of this cockpit and says what it removed; whatever it cannot prove dead it leaves and
 * names. It never spawns a process itself: every Docker call crosses the supplied `run`, and liveness crosses `processState`.
 */
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const mechanism = {
    id: 'runtime-probe-residue',
    module: 'packages/cockpit/src/environment/runtime-probe-residue.ts',
    exports: ['MEASURE_DIRECTORY_PREFIX', 'claimMeasureDirectory', 'sweepProbeResidue'],
} as const

export const MEASURE_DIRECTORY_PREFIX = 'cockpit-runtime-measure-'
const OWNER_FILE = 'owner'
// A directory with no owner file was killed between creation and its first write, or is being
// created right now; only age tells them apart, and a probe never outlives its five-minute window.
const UNOWNED_STALE_MS = 10 * 60_000
const PROBE_LABEL = 'dev.b0dea.cockpit.probe'
const BATCH_NAME = /-([0-9a-f]{32})(?:\.yml)?$/
const DOCKER_ID = /^[a-f0-9]{12,64}$/
const DOCKER_NAME = /^[a-z0-9][a-z0-9_.-]{0,200}$/

/** Run one Docker read or removal; `failed` carries the first line of Docker's complaint. */
export type ResidueRunner = (id: string, args: readonly string[]) => Promise<Readonly<{ kind: 'complete'; text: string }> | Readonly<{ kind: 'failed'; detail: string }>>

/** Whether a process id is running; anything short of proof of absence must answer `live` or `unavailable`. */
export type ProcessState = (pid: number) => Promise<'live' | 'absent' | 'unavailable'>

export type ProbeResidueOutcome =
    | Readonly<{ kind: 'complete'; removed: readonly string[]; left: readonly string[] }>
    | Readonly<{ kind: 'refusal'; reason: string; removed: readonly string[] }>

/** Mark a freshly created measure directory as owned by this process, so a later measure can tell it is alive. */
export async function claimMeasureDirectory(directory: string): Promise<void> {
    await writeFile(join(directory, OWNER_FILE), `${process.pid}\n`, { mode: 0o600 })
}

type MeasureDirectory = Readonly<{ path: string; alive: boolean; batches: readonly string[] }>

async function batchesIn(directory: string): Promise<string[]> {
    const names: string[] = []
    for (const where of [directory, join(directory, 'probe')]) {
        try { names.push(...await readdir(where)) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
        }
    }
    return names.flatMap((name) => BATCH_NAME.exec(name)?.[1] ?? [])
}

async function measureDirectories(temporaryDirectory: string, uid: number | undefined, processState: ProcessState): Promise<MeasureDirectory[]> {
    const found: MeasureDirectory[] = []
    for (const name of await readdir(temporaryDirectory)) {
        if (!new RegExp(`^${MEASURE_DIRECTORY_PREFIX}[A-Za-z0-9]{6}$`).test(name)) continue
        const path = join(temporaryDirectory, name)
        const status = await lstat(path)
        // Only a real directory of this user: a symlink or someone else's directory is not ours to judge or delete.
        if (!status.isDirectory() || status.isSymbolicLink() || (uid !== undefined && status.uid !== uid)) continue
        const young = Date.now() - status.mtimeMs < UNOWNED_STALE_MS
        let alive = young
        let pid = 0
        try { pid = Number((await readFile(join(path, OWNER_FILE), 'utf8')).trim()) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        // Only proof of absence marks an owner dead: a reused pid or a failed check keeps the directory.
        if (Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647) alive = (await processState(pid)) !== 'absent'
        found.push(Object.freeze({ path, alive, batches: Object.freeze(alive ? [] : await batchesIn(path)) }))
    }
    return found
}

interface Found { readonly kind: 'container' | 'network' | 'volume'; readonly handle: string; readonly project: string; readonly batchLabel: string }

async function discover(run: ResidueRunner): Promise<Found[] | string> {
    const listings = [
        ['container', ['ps', '-a', '--no-trunc', '--filter', `label=${PROBE_LABEL}`, '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "dev.b0dea.cockpit.probe"}}'], DOCKER_ID],
        ['network', ['network', 'ls', '--no-trunc', '--filter', `label=${PROBE_LABEL}`, '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "dev.b0dea.cockpit.probe"}}'], DOCKER_ID],
        ['volume', ['volume', 'ls', '--filter', `label=${PROBE_LABEL}`, '--format', '{{.Name}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "dev.b0dea.cockpit.probe"}}'], DOCKER_NAME],
    ] as const
    const found: Found[] = []
    for (const [kind, args, valid] of listings) {
        const listed = await run(`runtime:measure:residue:${kind}`, args)
        if (listed.kind !== 'complete') return `listing leftover probe ${kind}s failed (${listed.detail})`
        for (const line of listed.text.split('\n').filter(Boolean)) {
            const [handle = '', project = '', batchLabel = ''] = line.split('\t')
            if (!valid.test(handle)) return `docker listed a probe ${kind} with an unexpected identity`
            found.push({ kind, handle, project, batchLabel })
        }
    }
    return found
}

/**
 * Remove this cockpit's probe resources left by a dead measure. A resource is the probe's only if
 * it carries the probe label and a Compose project named `<projectPrefix>-probe-<batch>` (Compose
 * appends the stack hash) whose batch matches the label, so a different cockpit's probe, or any other stack, is never touched.
 * It is dead if no live measure exists in the temp directory, or if its batch is recorded in a
 * temp directory whose owner has exited; anything else may be running now and is only reported.
 */
export async function sweepProbeResidue(input: Readonly<{
    projectPrefix: string
    temporaryDirectory: string
    ownDirectory: string
    run: ResidueRunner
    processState: ProcessState
    uid?: number
}>): Promise<ProbeResidueOutcome> {
    const directories = (await measureDirectories(input.temporaryDirectory, input.uid, input.processState)).filter(({ path }) => path !== input.ownDirectory)
    const otherLive = directories.some(({ alive }) => alive)
    const deadBatches = new Set(directories.flatMap(({ batches }) => batches))
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
    const doomed = owned.filter(({ batch }) => !otherLive || deadBatches.has(batch))
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
