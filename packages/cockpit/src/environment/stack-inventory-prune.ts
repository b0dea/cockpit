/**
 * `cockpit stacks prune`: plans the removal of every orphaned stack and unreadable state folder the
 * inventory shows, binds the plan to a digest, and removes exactly that plan once it is approved.
 */
import { randomUUID } from 'node:crypto'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { sha256Hex } from '../sha256.js'
import { ENVIRONMENT_CODES, type CockpitId, type Diagnostic, type StackId } from './contract.js'
import { holderId } from './identity.js'
import { machineStackRemovalSteps, type MachineStackResource } from './reclaim.js'
import type { Observation, ObservedStack, StackCheckout, StackRow } from './stack-inventory.js'
import { loadStacksContext, observeWithDocker, refusalStatus, type Executor, type StacksContext, type StacksInput, type StacksOutcome } from './stack-inventory-report.js'
import { removeStackState, removeStateNamespaceFolder } from './state.js'

interface PlannedStack {
    readonly cockpitId: CockpitId
    readonly stackId: StackId
    readonly checkout: StackCheckout
    readonly reason: string
    readonly containers: readonly string[]
    readonly networks: readonly string[]
    readonly volumes: readonly string[]
    readonly stateFiles: readonly string[]
}

function plannedRow({ row, resources, files }: ObservedStack): PlannedStack {
    const named = (kind: MachineStackResource['kind']) => resources.filter((resource) => resource.kind === kind).map(({ name }) => name)
    return { cockpitId: row.cockpitId, stackId: row.stackId, checkout: row.checkout, reason: row.reason,
        containers: named('container'), networks: named('network'), volumes: named('volume'), stateFiles: files.map(({ path }) => path) }
}

/**
 * Whose orphans a prune removes. An agent's `--apply` passes this cockpit's `[autonomy]` policy, which
 * says nothing for another cockpit's stacks, so it covers this cockpit's stacks and the state folders
 * earlier builds left; a person who approved the preview covers the machine.
 */
export type StacksPruneScope = 'this-cockpit' | 'machine'

function planOf(observed: Observation, inScope: (row: StackRow) => boolean): Readonly<{ stacks: readonly ObservedStack[]; folders: Observation['folders']; digest: string; deletesData: boolean }> {
    const stacks = observed.stacks.filter(({ row }) => row.verdict === 'orphaned' && inScope(row))
    const folders = observed.folders.filter(({ row }) => row.verdict === 'orphaned')
    // The digest binds the exact resources and file bytes, so an approval covers only what was shown.
    const bound = {
        stacks: stacks.map(({ row, resources, files }) => ({ cockpitId: row.cockpitId, stackId: row.stackId,
            resources: resources.map(({ kind, id }) => `${kind}:${id}`), files: files.map(({ kind, path, sha256 }) => `${kind}:${path}:${sha256}`) })),
        folders: folders.map(({ row, fingerprint }) => `${row.path}:${fingerprint}`),
    }
    return { stacks, folders, digest: sha256Hex(JSON.stringify(bound)),
        deletesData: stacks.some(({ resources }) => resources.some(({ kind }) => kind === 'volume')) }
}

function otherCockpitsWarning(stacks: readonly ObservedStack[], configPath: string): readonly Diagnostic[] {
    if (stacks.length === 0) return []
    return [{ severity: 'warning', target: 'stacks',
        code: 'STACKS_PRUNE_UNCONFIRMED' as const satisfies typeof ENVIRONMENT_CODES.STACKS_PRUNE_UNCONFIRMED,
        message: `orphaned stacks of other cockpits are removed only with a person's approval, because this cockpit's [autonomy] policy does not speak for them; an agent's --apply leaves ${stacks.map(({ row }) => row.stackId).join(', ')}`,
        fix: `a person runs ${cockpitCommand('stacks prune', { config: configPath, args: '--interactive' })} in a terminal outside CI, reads the preview and types its digest` }]
}

/** What a person or an agent approves: the exact prune a fresh observation shows, and how to apply it. */
export interface StacksPruneSession {
    readonly preview: StacksOutcome
    /** The digest of the whole preview, which a person types to approve it. */
    readonly digest: string
    /** Whether the scope the session applies holds nothing to remove, and whether it deletes volumes. */
    readonly empty: boolean
    readonly deletesData: boolean
    apply(): Promise<StacksOutcome>
}

// Containers first, so no network or volume is still held when its removal runs.
const PRUNE_ORDER: readonly MachineStackResource['kind'][] = ['container', 'network', 'volume']

/**
 * Observes the machine and plans the prune of every orphaned stack and state folder. The preview lists
 * them all; `apply` removes those in `scope`, after observing again and only while that part of the plan
 * still has the digest it had at the preview: containers first, then networks and volumes, then the
 * state that holds the port lease, then unreadable state folders. A failed step stops the prune and
 * keeps the state, so the stack stays listed and the next prune resumes it.
 */
export async function beginStacksPrune(input: StacksInput, scope: StacksPruneScope,
    dependencies: Readonly<{ execute: Executor }>): Promise<StacksPruneSession | StacksOutcome> {
    const context = await loadStacksContext(input, dependencies.execute)
    return 'kind' in context ? refusalStatus(context) : openStacksPrune(context, scope, dependencies)
}

/** The prune of an already identified checkout's machine: what `beginStacksPrune` opens once the context is loaded. */
export async function openStacksPrune(context: StacksContext, scope: StacksPruneScope,
    dependencies: Readonly<{ execute: Executor }>): Promise<StacksPruneSession | StacksOutcome> {
    const observed = await observeWithDocker(context, dependencies.execute)
    if ('kind' in observed) return refusalStatus(observed)
    const thisCockpit = (row: StackRow) => row.cockpitId === context.own.cockpitId
    const inScope = scope === 'machine' ? () => true : thisCockpit
    const whole = planOf(observed, () => true)
    const plan = planOf(observed, inScope)
    const kept = observed.inventory.stacks.filter(({ verdict }) => verdict !== 'orphaned').length
    const summary = { digest: whole.digest, deletesData: whole.deletesData,
        stacks: whole.stacks.map((stack) => ({ ...plannedRow(stack), thisCockpit: thisCockpit(stack.row) })),
        stateFolders: whole.folders.map(({ row }) => ({ path: row.path, reason: row.reason })), kept }
    const wholeEmpty = whole.stacks.length === 0 && whole.folders.length === 0
    return {
        digest: whole.digest, empty: plan.stacks.length === 0 && plan.folders.length === 0, deletesData: plan.deletesData,
        preview: { status: 0, diagnostics: otherCockpitsWarning(whole.stacks.filter(({ row }) => !thisCockpit(row)), context.configPath),
            result: { dryRun: true, ...summary, apply: wholeEmpty ? null : cockpitCommand('stacks prune', { config: context.configPath, args: '--apply' }) } },
        apply: async () => {
            const again = await observeWithDocker(context, dependencies.execute)
            if ('kind' in again) return refusalStatus(again)
            const current = planOf(again, inScope)
            if (current.digest !== plan.digest) return { status: 2, result: null, diagnostics: [{ severity: 'error', target: 'stacks',
                code: 'STACKS_PRUNE_UNCONFIRMED' as const satisfies typeof ENVIRONMENT_CODES.STACKS_PRUNE_UNCONFIRMED,
                message: 'the orphaned stacks changed between the preview and the removal, so nothing was removed',
                fix: `preview again with ${cockpitCommand('stacks prune', { config: context.configPath })} and approve the new preview` }] }
            const ownerId = holderId({ stackId: context.own.stackId, checkoutId: context.own.checkoutId, sessionId: randomUUID() })
            const removed: PlannedStack[] = []
            const incomplete = (what: string): StacksOutcome => ({ status: 2, result: { removed }, diagnostics: [{ severity: 'error', target: 'stacks',
                code: 'STACKS_PRUNE_INCOMPLETE' as const satisfies typeof ENVIRONMENT_CODES.STACKS_PRUNE_INCOMPLETE,
                message: `prune stopped: ${what}; what it had not removed is still listed`,
                fix: `inspect the named resource, then run ${cockpitCommand('stacks prune', { config: context.configPath, args: '--apply' })} again to resume` }] })
            for (const stack of current.stacks) {
                for (const kind of PRUNE_ORDER) {
                    const batch = stack.resources.filter((resource) => resource.kind === kind)
                    if (batch.length === 0) continue
                    const removals = machineStackRemovalSteps(context.docker, again.selection!, batch) ?? [{ step: undefined, resources: batch }]
                    for (const { step, resources } of removals) {
                        const outcome = step === undefined ? undefined : authenticatedExecutionOutcome(await dependencies.execute(step), step)
                        if (outcome?.kind !== 'complete') return incomplete(`docker could not remove ${kind} ${resources.map(({ name }) => name).join(', ')} of ${stack.row.stackId}${outcome ? ` (${outcome.code})` : ''}`)
                    }
                }
                if (stack.namespace !== undefined && stack.files.length > 0) {
                    const state = await removeStackState(stack.namespace, stack.row.stackId, stack.files, { ownerId })
                    if (state.kind !== 'complete') return incomplete(`the state of ${stack.row.stackId} could not be removed: ${state.kind === 'refusal' ? state.message : 'it disappeared'}`)
                    if (state.value.kind === 'changed') return incomplete(state.value.reason)
                }
                removed.push(plannedRow(stack))
            }
            const folders: string[] = []
            for (const { row, fingerprint } of current.folders) {
                const folder = await removeStateNamespaceFolder(context.namespace, row.path, fingerprint!, { ownerId })
                if (folder.kind !== 'complete') return incomplete(`${row.path} could not be removed: ${folder.kind === 'refusal' ? folder.message : 'it disappeared'}`)
                if (folder.value.kind === 'changed') return incomplete(folder.value.reason)
                folders.push(row.path)
            }
            // The removal is reported only once a fresh observation no longer lists what was removed.
            const after = await observeWithDocker(context, dependencies.execute)
            if ('kind' in after) return refusalStatus(after)
            const left = planOf(after, inScope)
            const remaining = removed.filter(({ cockpitId, stackId }) => left.stacks.some(({ row }) => row.cockpitId === cockpitId && row.stackId === stackId))
            if (remaining.length > 0 || left.folders.some(({ row }) => folders.includes(row.path))) {
                return incomplete(`a fresh inventory still lists ${remaining.map(({ stackId }) => stackId).join(', ') || 'a removed state folder'}`)
            }
            return { status: 0, diagnostics: otherCockpitsWarning(planOf(after, (row) => !inScope(row)).stacks, context.configPath),
                result: { digest: plan.digest, removed, removedStateFolders: folders } }
        },
    }
}
