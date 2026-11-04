// One-service verbs on this checkout's own running stack: `ps`, `restart`, `rebuild` and `exec`. Each
// reaches the stack through the topology its runtime readiness authenticated, so the agent never names
// the hashed Compose project, its files or its profiles, and every step is one the runtime owner plans.
import { constants as osConstants } from 'node:os'
import type { ExecuteProbeOutcome, ForegroundProcessInput, ForegroundProcessOutcome } from '../../environment-exec/execute.js'
import { cockpitCommand } from '../../fix-catalogue.js'
import { ENVIRONMENT_CODES, errorCause, forwardedRefusal, type EnvironmentCommandOutcome, type EnvironmentDiagnostic, type ExecutionStep, type LifecycleProgress } from '../contract.js'
import { DeclarationRefusalError, serviceNotDeclared } from '../declaration.js'
import {
    admitRuntimeServiceHealth,
    observeRuntimeServiceStates,
    planRuntimeServiceExec,
    restartRuntimeService,
    startRuntimeService,
    type RuntimeServiceState,
    type RuntimeTopologyEvidence,
} from '../runtime.js'
import { collectFailureLogs } from './lifecycle.js'
import { lifecycleRefusal } from './shared.js'

export interface ServiceObservation {
    readonly topology: RuntimeTopologyEvidence
    readonly completedServices: LifecycleProgress['completedServices']
    /** Records the container a rebuild put in place of the one the stack was started with. */
    readonly recordContainer: (service: string, containerId: string) => Promise<readonly EnvironmentDiagnostic[]>
}

export interface ServiceCommandAdapters {
    readonly observe: (input: { readonly configPath: string }) => Promise<ServiceObservation>
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    readonly executeForeground: (input: ForegroundProcessInput, options: { readonly signal?: AbortSignal }) => Promise<ForegroundProcessOutcome>
    readonly signal?: AbortSignal
}

async function observeStack(verb: string, configPath: string, adapters: ServiceCommandAdapters,
    service?: string): Promise<ServiceObservation | Extract<EnvironmentCommandOutcome<never>, { kind: 'refusal' }>> {
    let observed: ServiceObservation
    try {
        observed = await adapters.observe({ configPath })
    } catch (error) {
        if (error instanceof DeclarationRefusalError) return forwardedRefusal([error.diagnostic])
        return lifecycleRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
            `${verb} could not reach this checkout's running stack: ${errorCause(error)}`, verb,
            `start the stack with ${cockpitCommand('up', { config: configPath })}, then rerun ${verb}`)
    }
    const declared = observed.topology.services.map(({ id }) => id)
    if (service !== undefined && !declared.includes(service)) {
        return forwardedRefusal([serviceNotDeclared(service, declared)])
    }
    return observed
}

export async function runServicePs(
    input: Readonly<{ configPath: string }>,
    adapters: ServiceCommandAdapters,
): Promise<EnvironmentCommandOutcome<Readonly<{ services: readonly RuntimeServiceState[] }>>> {
    const observed = await observeStack('ps', input.configPath, adapters)
    if ('kind' in observed) return observed
    const states = await observeRuntimeServiceStates({ topology: observed.topology, execute: adapters.execute })
    if (states.kind !== 'complete') return lifecycleRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
        `the stack's service states are unavailable: ${states.reason}`, 'ps')
    return { kind: 'complete', status: 0, diagnostics: [], result: { services: states.services } }
}

/**
 * `restart` restarts the container in place; `rebuild` builds the service's image and replaces its
 * container, for a change baked into the image. Both then wait for the service as `up` does and
 * report its logs when it does not become healthy.
 */
export async function runServiceRestart(
    input: Readonly<{ configPath: string; service: string; verb: 'restart' | 'rebuild' }>,
    adapters: ServiceCommandAdapters,
): Promise<EnvironmentCommandOutcome<Readonly<{ service: string; containerId: string; change: 'restarted' | 'rebuilt' }>>> {
    const observed = await observeStack(input.verb, input.configPath, adapters, input.service)
    if ('kind' in observed) return observed
    const run = { topology: observed.topology, service: input.service, execute: adapters.execute }
    const outcome = input.verb === 'rebuild' ? await startRuntimeService({ ...run, rebuild: true }) : await restartRuntimeService(run)
    const evidence = outcome.kind === 'observed' ? admitRuntimeServiceHealth(outcome.observation) : undefined
    if (!evidence) {
        const logs = await collectFailureLogs(outcome.kind === 'observed' ? outcome.observation
            : outcome.kind === 'failure' ? outcome.logs : undefined, input.service, adapters)
        return forwardedRefusal([
            { severity: 'error', code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, target: input.service,
                message: `service ${input.service} did not become healthy after ${input.verb}`,
                fix: `fix the error in the log excerpt, then rerun ${input.verb}` },
            ...logs])
    }
    const recorded = observed.completedServices.find(({ service }) => service === input.service)
    if (recorded && recorded.containerId !== evidence.containerId) {
        const refused = await observed.recordContainer(input.service, evidence.containerId)
        if (refused.length > 0) return forwardedRefusal(refused)
    }
    return { kind: 'complete', status: 0, diagnostics: [],
        result: { service: input.service, containerId: evidence.containerId, change: input.verb === 'rebuild' ? 'rebuilt' : 'restarted' } }
}

// Like a session, a completed exec exits with its command's own status (128 plus the signal number
// when a signal ended it); a refused one exits 2, or 130 when cancelled.
export type ServiceExecResult =
    | Readonly<{ kind: 'complete'; status: number; diagnostics: readonly EnvironmentDiagnostic[]; result: Readonly<{ exitCode: number; signal: NodeJS.Signals | null }> }>
    | Readonly<{ kind: 'refusal'; status: number; diagnostics: readonly EnvironmentDiagnostic[]; result: null }>

/**
 * Runs a command inside one service's container in the foreground. A command that exits nonzero
 * is the command's answer, not a cockpit failure, so its status passes through as `session` does.
 */
export async function runServiceExec(
    input: Readonly<{ configPath: string; service: string; argv: readonly [string, ...string[]]; tty: boolean }>,
    adapters: ServiceCommandAdapters,
): Promise<ServiceExecResult> {
    const observed = await observeStack('exec', input.configPath, adapters, input.service)
    if ('kind' in observed) return observed
    const planned = planRuntimeServiceExec({ topology: observed.topology, service: input.service, argv: input.argv, tty: input.tty })
    if (!planned) return lifecycleRefusal(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
        `the command for service ${input.service} could not be planned from the stack's topology`, input.service)
    const child = await adapters.executeForeground(planned, adapters.signal ? { signal: adapters.signal } : {})
    if (child.kind === 'refusal') return { kind: 'refusal', status: child.code === ENVIRONMENT_CODES.EXECUTION_ABORTED ? 130 : 2, result: null,
        diagnostics: [{ severity: 'error', code: child.code, target: input.service,
            message: `the command in service ${input.service} could not be run to completion` }] }
    const signalNumber = child.signal ? osConstants.signals[child.signal] : undefined
    const status = signalNumber !== undefined ? 128 + signalNumber : child.exitCode
    return { kind: 'complete', status, diagnostics: status === 0 ? [] : [{
        severity: 'error', code: ENVIRONMENT_CODES.EXECUTION_STEP_FAILED, target: input.service,
        message: `the command in service ${input.service} ${child.signal ? `was terminated by ${child.signal}` : `exited with status ${child.exitCode}`}`,
    }], result: { exitCode: child.exitCode, signal: child.signal } }
}
