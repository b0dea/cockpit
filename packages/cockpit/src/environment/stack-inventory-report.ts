/**
 * `cockpit stacks`: identifies the checkout running the command, observes the machine through the
 * local Docker daemon, and lists every stack with its verdict. It changes nothing; the prune in
 * `stack-inventory-prune.ts` opens from the same context.
 */
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { loadCockpitConfig } from '../config/load.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { ENVIRONMENT_CODES, type Diagnostic, type EnvironmentDiagnostic, type ExecutionStep } from './contract.js'
import { selectLocalDockerDaemon } from './docker-daemon.js'
import { resolveDockerExecutable, resolveGitExecutable, type ResolvedExecutable } from './executable.js'
import { checkoutId as deriveCheckoutId, stackId as deriveStackId } from './identity.js'
import { discoverMachineStacks } from './reclaim.js'
import { consumeSetupCheckoutProjection, observeSetupCheckout, withSetupCheckoutProjection } from './setup-observation.js'
import { observeMachineStacks, refuse, type Observation, type OwnCheckout, type Refusal } from './stack-inventory.js'
import { selectStateRoot, type StateNamespace } from './state.js'

export type Executor = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>

/** What `cockpit stacks` and its prune are run with: the configuration and the caller's environment. */
export interface StacksInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface StacksContext {
    readonly configPath: string
    readonly namespace: StateNamespace
    readonly own: OwnCheckout & Readonly<{ checkoutId: ReturnType<typeof deriveCheckoutId> }>
    readonly docker: Readonly<{ executable: ResolvedExecutable; context: string; host?: string; cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number }>
}

const STEP_TIMEOUT_MS = 10_000

export async function loadStacksContext({ configPath, env }: StacksInput, execute: Executor): Promise<StacksContext | Refusal> {
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete') return { kind: 'refusal', diagnostics: loaded.diagnostics as readonly EnvironmentDiagnostic[] }
    const source = loaded.result.source
    if (process.platform !== 'darwin' && process.platform !== 'linux') return refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'cockpit state is kept on macOS or Linux only', process.platform)
    const git = await resolveGitExecutable(env)
    if (git.state !== 'available') return refuse(ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID, git.reason, 'git')
    const observedAt = new Date().toISOString()
    const observed = await observeSetupCheckout({ source, cockpitName: loaded.result.config.cockpit.name, observedAt,
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), gitExecutable: git.value })
    if (observed.state === 'failed') return refuse(observed.code, observed.reason, source.path)
    const checkout = await withSetupCheckoutProjection(observed, { source, cockpitName: loaded.result.config.cockpit.name,
        evaluatedAt: Date.parse(observedAt) }, consumeSetupCheckoutProjection)
    if (!checkout) return refuse(ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID, 'the checkout running this command could not be identified', source.path)
    const namespace = await selectStateRoot({ platform: process.platform, home: env.HOME, xdgStateHome: env.XDG_STATE_HOME,
        checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath], cockpitId: checkout.cockpitId })
    if (namespace.kind !== 'complete') return namespace.kind === 'refusal' ? refuse(namespace.code, namespace.message, namespace.target)
        : refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'the state root is unavailable', source.path)
    // Prune deletes, so the daemon is fixed once, as for down and reset, and every step addresses it.
    const daemon = await selectLocalDockerDaemon(env, STEP_TIMEOUT_MS, execute, { command: 'stacks',
        localOnly: 'the inventory and its prune describe this machine, which a remote daemon says nothing about' })
    if (daemon.kind === 'refusal') return { kind: 'refusal', diagnostics: [daemon.diagnostic as EnvironmentDiagnostic] }
    const docker = await resolveDockerExecutable(env)
    if (docker.state !== 'available') return refuse(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, docker.reason, 'docker')
    return {
        configPath: source.path, namespace: namespace.value,
        own: { cockpitId: checkout.cockpitId, checkoutId: checkout.checkoutId, mainCheckoutPath: checkout.mainCheckoutPath,
            stackId: deriveStackId({ cockpitId: checkout.cockpitId, checkoutId: checkout.checkoutId, variant: { kind: 'shared' } }) },
        docker: { executable: docker.value, context: daemon.dockerContext, ...(env.DOCKER_HOST === undefined ? {} : { host: env.DOCKER_HOST }),
            cwd: checkout.currentCheckoutPath, env: { PATH: env.PATH ?? '' }, timeoutMs: STEP_TIMEOUT_MS },
    }
}

export async function observeWithDocker(context: StacksContext, execute: Executor): Promise<Observation | Refusal> {
    const discovery = await discoverMachineStacks(context.docker, execute)
    if (discovery === undefined) return refuse(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
        `the containers, networks and volumes cockpit labels could not be listed on Docker context ${context.docker.context}`, 'docker',
        'start Docker, or select the local context that runs cockpit stacks, then retry')
    return observeMachineStacks({ namespace: context.namespace, own: context.own, discovery })
}

export interface StacksOutcome {
    readonly status: number
    readonly result: unknown
    readonly diagnostics: readonly Diagnostic[]
}

export function refusalStatus(refusal: Refusal): StacksOutcome {
    return { status: 2, result: null, diagnostics: refusal.diagnostics }
}

/** `cockpit stacks`: lists every stack this machine knows about, and changes nothing. */
export async function runStacksInventory(input: StacksInput, dependencies: Readonly<{ execute: Executor }>): Promise<StacksOutcome> {
    const context = await loadStacksContext(input, dependencies.execute)
    if ('kind' in context) return refusalStatus(context)
    const observed = await observeWithDocker(context, dependencies.execute)
    if ('kind' in observed) return refusalStatus(observed)
    const orphaned = observed.inventory.stacks.filter(({ verdict }) => verdict === 'orphaned').length
        + observed.inventory.stateFolders.filter(({ verdict }) => verdict === 'orphaned').length
    return { status: 0, result: observed.inventory, diagnostics: orphaned === 0 ? [] : [orphanedWarning(orphaned, context.configPath)] }
}

function orphanedWarning(count: number, configPath: string): Diagnostic {
    return { severity: 'warning', target: 'stacks',
        code: 'STACKS_ORPHANED' as const satisfies typeof ENVIRONMENT_CODES.STACKS_ORPHANED,
        message: `${count === 1 ? '1 stack or state folder on this machine is' : `${count} stacks or state folders on this machine are`} orphaned: its checkout is gone or its state cannot be read, and it still holds containers, volumes, a port lease or state`,
        fix: `preview the removal with ${cockpitCommand('stacks prune', { config: configPath })}, then apply it with --apply` }
}
