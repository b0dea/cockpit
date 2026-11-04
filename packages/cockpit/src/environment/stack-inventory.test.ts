import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { readRootPortInventory } from './claims.js'
import type { CockpitId, StackId } from './contract.js'
import { checkoutId, cockpitId as deriveCockpitId, stackId as deriveStackId } from './identity.js'
import { discoverMachineStacks } from './reclaim.js'
import { inspectMachineStacksForDoctor, observeMachineStacks, openStacksPrune, type StacksContext, type StacksPruneSession } from './stack-inventory.js'
import { selectStateRoot } from './state.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

// Serves each kind's rows from a file, and removes a row on `rm`, recording the removal.
const fakeDocker = `#!/bin/sh
if [ "$1" = context ] && [ "$2" = inspect ]; then /bin/cat -- "$PWD/selection.context"; exit; fi
case "$1" in --host) shift 2;; *) exit 91;; esac
kind="$1"
if [ "$2" = rm ]; then for id do last="$id"; done; echo "$kind $last" >> "$PWD/removed"
  /usr/bin/grep -v -F "\\"id\\":\\"$last\\"" "$PWD/$kind.rows" > "$PWD/$kind.next"; /bin/mv "$PWD/$kind.next" "$PWD/$kind.rows"; exit 0; fi
/bin/cat -- "$PWD/$kind.rows"
`

const stackOf = (cockpit: CockpitId, path: string) => deriveStackId({ cockpitId: cockpit, checkoutId: checkoutId({ checkoutPath: path }), variant: { kind: 'shared' } })
const segment = (identity: string) => identity.replaceAll(':', '_')

interface Row { id: string; name: string; state?: string; cockpit: CockpitId; stack: StackId; workingDir?: string; config?: string }
const encode = ({ id, name, state = '', cockpit, stack, workingDir = '', config = sha('config') }: Row) => JSON.stringify({ id, name, state, labels: {
    'dev.b0dea.cockpit.stack-id': stack, 'dev.b0dea.cockpit.config-sha256': config, 'dev.b0dea.cockpit.owner-id': cockpit,
    'com.docker.compose.project': name.split('-').slice(0, 3).join('-'), 'com.docker.compose.project.working_dir': workingDir } })

async function machine() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-stacks-')))
    temporary.push(root)
    // A main checkout with one live worktree, laid out as Git lays them out. Two more worktrees were deleted.
    const main = join(root, 'my-app')
    const live = join(root, 'my-app-live')
    await mkdir(join(main, '.git', 'worktrees', 'live'), { recursive: true })
    await mkdir(live)
    await writeFile(join(live, '.git'), `gitdir: ${main}/.git/worktrees/live\n`)
    await writeFile(join(main, '.git', 'worktrees', 'live', 'gitdir'), `${live}/.git\n`)
    await writeFile(join(main, '.git', 'worktrees', 'live', 'commondir'), '../..\n')
    const cockpit = deriveCockpitId({ name: 'my-app', mainCheckoutPath: main })
    const other = deriveCockpitId({ name: 'other-app', mainCheckoutPath: join(root, 'other-app') })
    const stacks = {
        own: stackOf(cockpit, main), live: stackOf(cockpit, live),
        gone: stackOf(cockpit, join(root, 'my-app-gone')), downed: stackOf(cockpit, join(root, 'my-app-downed')),
        busy: `stack:${sha('busy')}` as StackId, idle: `stack:${sha('idle')}` as StackId,
        // Not derived from any checkout path, as a stack variant other than the shared one would be: only its holder names its checkout.
        held: `stack:${sha('held')}` as StackId,
    }
    const home = join(root, 'home')
    await mkdir(home)
    const selected = await selectStateRoot({ platform: 'linux', home, cockpitId: cockpit })
    if (selected.kind !== 'complete') throw new Error(JSON.stringify(selected))
    const namespace = selected.value
    const record = async (owner: CockpitId, stack: StackId, body: string) => {
        const path = join(namespace.root, 'cockpits', segment(owner), 'records', 'coordination', `${segment(stack)}.json`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, body)
    }
    const held = (owner: CockpitId, stack: StackId, port: number, checkout = `checkout:${sha(stack)}`) => JSON.stringify({ format: 'cockpit-state/v1', kind: 'coordination', cockpitId: owner,
        subjectId: stack, revision: 1, updatedAt: '2026-11-01T10:00:00.000Z', value: {
            holders: [{ holderId: `holder:${sha(stack)}:session`, checkoutId: checkout, claimedAt: '2026-11-01T10:00:00.000Z' }],
            lease: { offset: port - 4100, ports: { API_PORT: port }, released: false, declaration: { step: 100, count: 27, bases: { API_PORT: 4100 } } },
            lastReleasedHolder: null, drain: null } })
    await record(cockpit, stacks.live, held(cockpit, stacks.live, 4200, checkoutId({ checkoutPath: live })))
    await record(cockpit, stacks.held, held(cockpit, stacks.held, 4500, checkoutId({ checkoutPath: live })))
    await record(cockpit, stacks.gone, held(cockpit, stacks.gone, 4300))
    // Downed before its worktree was deleted: no container is left to say where it ran, only its lease.
    await record(cockpit, stacks.downed, held(cockpit, stacks.downed, 4400))
    await record(other, stacks.busy, '{"written by": "an earlier cockpit"')
    await record(other, stacks.idle, '{"written by": "an earlier cockpit"')
    // An earlier build named its folders with colons, and one folder names no cockpit at all.
    const legacy = join(namespace.root, 'cockpits', `cockpit:old-app:${sha('old')}`)
    const stray = join(namespace.root, 'cockpits', 'not-a-cockpit')
    // Named as current builds name state, but laid out as this version does not read: a newer version's, perhaps.
    const newer = join(namespace.root, 'cockpits', segment(deriveCockpitId({ name: 'newer-app', mainCheckoutPath: join(root, 'newer-app') })))
    await mkdir(join(legacy, 'records'), { recursive: true })
    await mkdir(stray)
    await mkdir(join(newer, 'records', 'coordination'), { recursive: true })
    await writeFile(join(newer, 'records', 'coordination', 'written-by-a-newer-version.json'), '{}')

    const docker = join(root, 'docker')
    await mkdir(docker)
    await writeFile(join(docker, 'selection.context'), `${JSON.stringify({ context: 'synthetic', endpoint: 'unix:///tmp/synthetic-docker.sock' })}\n`)
    const rows = (kind: string, items: readonly Row[]) => writeFile(join(docker, `${kind}.rows`), items.map(encode).map((line) => `${line}\n`).join(''))
    await rows('container', [
        { id: 'c-live', name: 'my-app-aaaaaaaaaaaa-api-1', state: 'running', cockpit, stack: stacks.live, workingDir: join(live, 'cockpit') },
        { id: 'c-gone', name: 'my-app-bbbbbbbbbbbb-api-1', state: 'exited', cockpit, stack: stacks.gone, workingDir: join(root, 'my-app-gone', 'cockpit') },
        { id: 'c-busy', name: 'other-app-cccccccccccc-api-1', state: 'running', cockpit: other, stack: stacks.busy },
        { id: 'c-idle', name: 'other-app-dddddddddddd-api-1', state: 'exited', cockpit: other, stack: stacks.idle },
        // Not every ownership label is well formed, so nothing attributes it to a stack.
        { id: 'c-partial', name: 'my-app-eeeeeeeeeeee-api-1', state: 'running', cockpit, stack: stacks.gone, config: 'not-a-digest' },
    ])
    await rows('network', [{ id: 'n-gone', name: 'my-app-bbbbbbbbbbbb_default', cockpit, stack: stacks.gone }])
    await rows('volume', [{ id: 'my-app-bbbbbbbbbbbb_data', name: 'my-app-bbbbbbbbbbbb_data', cockpit, stack: stacks.gone }])
    const script = join(docker, 'docker')
    await writeFile(script, fakeDocker)
    await chmod(script, 0o700)
    const executable = { canonicalPath: script, invocationPath: script, sha256: sha(fakeDocker), executionMode: 'verified-path' as const }
    const context: StacksContext = {
        configPath: join(main, 'cockpit.toml'), namespace,
        own: { cockpitId: cockpit, checkoutId: checkoutId({ checkoutPath: main }), mainCheckoutPath: main, stackId: stacks.own },
        docker: { executable, context: 'synthetic', cwd: docker, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000 },
    }
    return { root, main, live, cockpit, other, stacks, namespace, context, docker, legacy, newer, stray, rows }
}

const verdicts = (observed: Awaited<ReturnType<typeof observeMachineStacks>>) => 'kind' in observed ? observed
    : Object.fromEntries(observed.inventory.stacks.map((row) => [row.stackId, { verdict: row.verdict, checkout: row.checkout.status, state: row.state.status }]))

describe('machine stack inventory', () => {
    it('proves each stack\'s checkout from cockpit state and Docker labels, and calls orphaned only what no checkout can reach', async () => {
        const { main, live, cockpit, other, stacks, namespace, context, legacy, newer, stray } = await machine()
        const discovery = await discoverMachineStacks(context.docker, executeProbe)
        expect(discovery?.unattributed).toBe(1)
        const observed = await observeMachineStacks({ namespace, own: context.own, discovery })
        expect(verdicts(observed)).toEqual({
            [stacks.live]: { verdict: 'kept', checkout: 'present', state: 'readable' },
            [stacks.held]: { verdict: 'kept', checkout: 'present', state: 'readable' },
            [stacks.gone]: { verdict: 'orphaned', checkout: 'missing', state: 'readable' },
            [stacks.downed]: { verdict: 'orphaned', checkout: 'missing', state: 'readable' },
            [stacks.busy]: { verdict: 'kept', checkout: 'unknown', state: 'malformed' },
            // Unreadable state may be a newer version's for a checkout that exists: kept, even with nothing running.
            [stacks.idle]: { verdict: 'kept', checkout: 'unknown', state: 'malformed' },
        })
        if ('kind' in observed) throw new Error('unreachable')
        const row = (stack: StackId) => observed.inventory.stacks.find(({ stackId }) => stackId === stack)!
        // Each checkout says where it was read from; a lease the stack still holds is listed.
        expect(row(stacks.live).checkout).toEqual({ path: live, status: 'present', source: `a checkout Git records for ${main}` })
        expect(row(stacks.gone)).toMatchObject({ cockpitId: cockpit, ports: { API_PORT: 4300 }, containers: { running: [], stopped: ['my-app-bbbbbbbbbbbb-api-1'] },
            networks: ['my-app-bbbbbbbbbbbb_default'], volumes: ['my-app-bbbbbbbbbbbb_data'],
            lastActivity: { at: '2026-11-01T10:00:00.000Z', source: 'state record' },
            checkout: { path: join(dirname(main), 'my-app-gone'), source: 'the Compose working directory label of container my-app-bbbbbbbbbbbb-api-1' } })
        expect(row(stacks.downed).checkout).toEqual({ path: null, status: 'missing', source: `none of the checkouts Git records for ${main} is this stack's` })
        expect(row(stacks.busy)).toMatchObject({ cockpitId: other, reason: expect.stringContaining('no checkout is proven gone') })
        expect(observed.inventory.stateFolders).toEqual([
            expect.objectContaining({ path: legacy, verdict: 'orphaned' }),
            expect.objectContaining({ path: newer, verdict: 'kept' }),
            expect.objectContaining({ path: stray, cockpitId: null, verdict: 'kept' }),
        ])

        // Doctor reads state and checkouts only: the gone checkouts are proven, the unreadable records reported, nothing is called safe to run.
        const doctor = await inspectMachineStacksForDoctor({ namespace, own: context.own, configPath: context.configPath })
        expect(doctor).toEqual([expect.objectContaining({ severity: 'warning', code: 'STACKS_ORPHANED',
            message: expect.stringContaining('2 whose checkout no longer exists; 2 whose state this cockpit version cannot read'),
            fix: expect.stringContaining(`npx --no cockpit stacks prune --config ${context.configPath}`) })])

        // State that cannot be read in an unexpected way leaves the inventory unknown: a named refusal, a doctor warning.
        await writeFile(join(namespace.root, 'cockpits', other.replaceAll(':', '_'), 'records', 'lifecycle'), 'not a directory')
        expect(await observeMachineStacks({ namespace, own: context.own, discovery })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'STATE_RECORD_MALFORMED' }] })
        expect(await inspectMachineStacksForDoctor({ namespace, own: context.own, configPath: context.configPath }))
            .toEqual([expect.objectContaining({ severity: 'warning', code: 'STATE_RECORD_MALFORMED', message: expect.stringContaining('did not look for orphaned stacks') })])
    })

    it('removes exactly the previewed orphans and their port leases, and nothing when the orphans changed after the preview', async () => {
        const { cockpit, stacks, namespace, context, docker, legacy, newer, stray, rows } = await machine()
        const opened = await openStacksPrune(context, { execute: executeProbe }) as StacksPruneSession
        expect(opened).toMatchObject({ empty: false, deletesData: true, preview: { status: 0, result: { dryRun: true, kept: 4,
            stacks: [expect.objectContaining({ stackId: expect.any(String) }), expect.anything()],
            stateFolders: [{ path: legacy, reason: expect.any(String) }] } } })
        expect(await readFile(join(docker, 'removed'), 'utf8').catch(() => '')).toBe('')

        // A resource that appeared after the preview changes the plan, so the approval no longer covers it.
        const gone = { name: 'my-app-bbbbbbbbbbbb_default', cockpit, stack: stacks.gone }
        await rows('network', [{ id: 'n-gone', ...gone }, { id: 'n-late', ...gone }])
        expect(await opened.apply()).toMatchObject({ status: 2, diagnostics: [{ code: 'STACKS_PRUNE_UNCONFIRMED' }] })
        expect(await readFile(join(docker, 'removed'), 'utf8').catch(() => '')).toBe('')
        await rows('network', [{ id: 'n-gone', ...gone }])

        const approved = await openStacksPrune(context, { execute: executeProbe }) as StacksPruneSession
        const applied = await approved.apply()
        expect(applied).toMatchObject({ status: 0, result: { digest: approved.digest, removedStateFolders: [legacy] } })
        // Containers go before the network they hold, and the network before the volume.
        expect((await readFile(join(docker, 'removed'), 'utf8')).trim().split('\n')).toEqual([
            'container c-gone', 'network n-gone', 'volume my-app-bbbbbbbbbbbb_data'])
        const leases = await readRootPortInventory(namespace)
        expect(leases.kind === 'complete' && leases.value.map(({ stackId }) => stackId).sort()).toEqual([stacks.live, stacks.held].sort())
        const after = await observeMachineStacks({ namespace, own: context.own, discovery: await discoverMachineStacks(context.docker, executeProbe) })
        expect(verdicts(after)).toEqual({
            [stacks.live]: { verdict: 'kept', checkout: 'present', state: 'readable' },
            [stacks.held]: { verdict: 'kept', checkout: 'present', state: 'readable' },
            [stacks.busy]: { verdict: 'kept', checkout: 'unknown', state: 'malformed' },
            [stacks.idle]: { verdict: 'kept', checkout: 'unknown', state: 'malformed' },
        })
        if ('kind' in after) throw new Error('unreachable')
        expect(after.inventory.stateFolders.map(({ path }) => path)).toEqual([newer, stray])
    })
})
