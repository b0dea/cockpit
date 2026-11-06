import { randomBytes } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { cleanupFencedExecution, repairFencedExecution } from '../../environment-exec/execute.js'
import {
    ENVIRONMENT_CODES,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type ExecutionStep,
    type LifecycleProgress,
    forwardedRefusal,
} from '../contract.js'
import { cockpitCommand } from '../../fix-catalogue.js'
import {
    decodeLifecycleRecord,
    earlierNameRefusalMessage,
    findStackUnderEarlierName,
    recordLifecycleSeeded,
    recordLifecycleStarted,
    type CurrentLifecycleRecord,
    type LifecycleRecordValue,
    type RuntimeInputs,
    type LifecycleStageProjection,
} from '../lifecycle-stage.js'
import {
    compensateAcquiredPortHolder,
    deriveEntrypoints,
    inspectPortLeaseProjection,
    revalidatePortLeaseProjection,
    observeRetainedPortFamily,
    inspectRecordedPortDeclaration,
    projectRetainedPortFamilyResult,
    releasePortFamily,
    type LeasePortFamilyResult,
    type PortLeaseProjection,
} from '../ports.js'
import { consumeLifecycleIssuance, planSleep, admitUpProgress, planAdmittedUp } from '../lifecycle.js'
import {
    admitRuntimeServiceHealth,
    revalidateRuntimeService,
    startRuntimeService,
    observeRuntimeServiceColdStart,
    resolveRuntimeServiceOrder,
    stopRuntime,
    type RuntimeServiceEvidence,
    type RuntimeServiceFailureEvidence,
    type RuntimeServiceOutcome,
    type RuntimeServiceObservation,
    type RuntimeTopologyEvidence,
} from '../runtime.js'
import { admitFailureLogs, failureLogExcerpt, planFailureLogs } from '../logs.js'
import {
    inspectSleepDrainRecovery,
    settleInterruptedDrainRepair,
    recoverSleepDrainReservation,
    reserveDrain,
    reserveDrainAttempt,
    observeProcessStart,
    processHost,
    releaseDeadSessionHolders,
} from '../claims.js'
import { observationSatisfiesExpectation } from '../observations.js'
import {
    type AcquiredPorts,
    type LifecycleRunContext,
    type ReadinessRefusal,
    type RuntimeReadiness,
    type SessionCommandAdapters,
    type SessionCommandInput,
    type SessionCommandResult,
    type SleepCommandAdapters,
    type SleepCommandInput,
    type SleepCommandResult,
    type UpCommandAdapters,
    type UpCommandInput,
    type UpCommandResult,
    issuedLifecycleRuns,
    lifecycleContextRefusal,
    withLifecycleConfiguration,
    withLifecycleRunNotices,
} from './lifecycle-context.js'
import {
    exactCommandConfigPath,
    invalidateCompletedLifecycle,
    lifecycleSuggestion,
    publishDrainOutcome,
    publishLifecycleRecord,
    readLifecycleRecord,
    repairRequired,
    unheldStack,
} from './lifecycle-state.js'
import { lifecycleRefusal, ownerDiagnostic, uniqueDiagnostics } from './shared.js'
import { forgetStackInputs } from '../stack-inputs.js'

function seconds(millis: number): string {
    return String(millis / 1_000)
}

// A floor refusal is acted on by changing the machine or the declared field, so it states both
// numbers in the unit that field is written in.
function machineFloorRefusal(failed: EnvironmentObservation): Extract<EnvironmentCommandOutcome<never>, { kind: 'refusal' }> {
    const observed = failed.observed.state === 'available' ? Number(failed.observed.value) : Number.NaN
    const floor = failed.expectation.kind === 'minimum' ? failed.expectation.value : Number.NaN
    const mb = (bytes: number) => `${Math.floor(bytes / 1_048_576)} MB`
    const cpu = failed.code === ENVIRONMENT_CODES.MACHINE_CPU_BELOW_FLOOR
    const disk = failed.code === ENVIRONMENT_CODES.MACHINE_DISK_BELOW_FLOOR
    const [measured, field, declared] = cpu ? [`${observed / 1_000} CPUs`, 'runtime_cpus', `${floor / 1_000} CPUs`]
        : disk ? [`${mb(observed)} of free disk`, 'free_disk_mb', mb(floor)]
            : [`${mb(observed)} of memory`, 'runtime_memory_mb', mb(floor)]
    return { kind: 'refusal', status: 2, result: null, diagnostics: [{
        severity: 'error',
        // Literals, so the diagnostic inventory captures the fix beside each code.
        code: cpu ? 'MACHINE_CPU_BELOW_FLOOR' satisfies typeof ENVIRONMENT_CODES.MACHINE_CPU_BELOW_FLOOR
            : disk ? 'MACHINE_DISK_BELOW_FLOOR' satisfies typeof ENVIRONMENT_CODES.MACHINE_DISK_BELOW_FLOOR
                : 'MACHINE_MEMORY_BELOW_FLOOR' satisfies typeof ENVIRONMENT_CODES.MACHINE_MEMORY_BELOW_FLOOR,
        message: `the container runtime has ${measured}, below the ${declared} that environment.machine.${field} declares`,
        target: failed.source,
        fix: 'give the container runtime more resources (its VM or Docker Desktop settings) or lower the declared environment.machine floor in cockpit.toml deliberately and run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>, then retry',
    }] }
}

// A compose-first stack starts from its Compose files as well as cockpit.toml; naming only
// cockpit.toml sent a person who had edited compose.yml looking for a change that was not there.
function runtimeChangedRefusal(context: LifecycleRunContext, changed: string): ReturnType<typeof lifecycleRefusal> {
    return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
        `the recorded stack runs an earlier version of the services, ports, mounts or images: ${changed}, and up does not replace a running stack — fix: run \`${lifecycleSuggestion(context, 'down')}\`, then \`${lifecycleSuggestion(context, 'up')}\``,
        context.stackId)
}

function changedRuntimeInputs(recorded: RuntimeInputs | undefined, current: RuntimeInputs | undefined, fallback: string): string {
    const names = (values: readonly string[], conjunction: string) => values.length <= 1 ? values.join('')
        : `${values.slice(0, -1).join(', ')} ${conjunction} ${values.at(-1)}`
    if (recorded && current) {
        const changed = [...new Set([...Object.keys(recorded), ...Object.keys(current)])]
            .filter((name) => recorded[name] !== current[name]).sort()
        if (changed.length > 0) return `${names(changed, 'and')} changed since it started`
    }
    // Without a recorded digest per file, name every file the stack is started from.
    const candidates = current ? Object.keys(current).sort() : [fallback]
    return `${names(candidates, 'or')} changed since it started`
}

export { decodeLifecycleRecord } from '../lifecycle-stage.js'

type ServiceAdmission =
    | { readonly kind: 'complete'; readonly evidence: RuntimeServiceEvidence }
    | { readonly kind: 'stale' }
    | { readonly kind: 'failure'; readonly logs?: RuntimeServiceFailureEvidence | RuntimeServiceObservation }

type ServiceStart = Exclude<ServiceAdmission, { readonly kind: 'failure' }>
    /** `stop` is present once Compose was asked to start the service. */
    | (Extract<ServiceAdmission, { readonly kind: 'failure' }> & { readonly stop?: ExecutionStep })

function serviceAdmission(outcome: RuntimeServiceOutcome): ServiceStart {
    if (outcome.kind !== 'observed') return outcome
    const evidence = admitRuntimeServiceHealth(outcome.observation)
    return evidence ? { kind: 'complete', evidence }
        : { kind: 'failure', logs: outcome.observation, ...outcome.stop ? { stop: outcome.stop } : {} }
}

export async function revalidateService(
    topology: RuntimeTopologyEvidence,
    completed: LifecycleProgress['completedServices'][number],
    adapters: Pick<UpCommandAdapters, 'execute'>,
): Promise<ServiceAdmission> {
    return serviceAdmission(await revalidateRuntimeService({
        topology, service: completed.service, expectedContainerId: completed.containerId,
        execute: (step) => adapters.execute(step),
    }))
}

async function startService(
    topology: RuntimeTopologyEvidence,
    service: string,
    adapters: UpCommandAdapters,
): Promise<ServiceStart> {
    return serviceAdmission(await startRuntimeService({ topology, service, execute: (step) => adapters.execute(step) }))
}

// Failure evidence for a service that did not become healthy: its bounded logs as one diagnostic,
// read before anything else touches the container. When this `up` started the service, `stop` then
// stops it: under a restart policy a failed service otherwise restarted until `down`. The
// container is kept, with its logs, and the next `up` starts it again.
async function reportFailedService(
    evidence: RuntimeServiceFailureEvidence | RuntimeServiceObservation | undefined,
    service: string,
    context: LifecycleRunContext,
    adapters: UpCommandAdapters,
    stop?: ExecutionStep,
): Promise<readonly EnvironmentDiagnostic[]> {
    const logs = await collectFailureLogs(evidence, service, adapters)
    const stopped = stop ? (await adapters.execute(stop)).kind === 'complete' : undefined
    const next = `fix the error in the log excerpt, then run \`${lifecycleSuggestion(context, 'up')}\` to resume, or \`${lifecycleSuggestion(context, 'down')}\` to remove the stack`
    const fix = stopped ? `cockpit stopped the failed container and kept it with its logs; ${next}` : next
    return [
        ...logs.map((diagnostic) => diagnostic.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED ? { ...diagnostic, fix } : diagnostic),
        ...(stopped === false ? [ownerDiagnostic(ENVIRONMENT_CODES.EXECUTION_COMPENSATION_STEP_FAILED,
            `the failed service ${service} could not be stopped, so it may keep restarting; run \`${lifecycleSuggestion(context, 'down')}\` to remove it`,
            service)] : []),
    ]
}

export async function collectFailureLogs(
    evidence: RuntimeServiceFailureEvidence | RuntimeServiceObservation | undefined,
    service: string,
    adapters: Pick<UpCommandAdapters, 'execute'>,
): Promise<readonly EnvironmentDiagnostic[]> {
    if (!evidence) return [ownerDiagnostic(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'bounded failure logs are unavailable',
        service,
    )]
    const plan = planFailureLogs({ evidence, tail: 200, timeoutMs: 10_000, outputLimitBytes: 1_048_576 })
    if (plan.kind !== 'planned') return [ownerDiagnostic(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        plan.reason,
        service,
    )]
    const outcome = await adapters.execute(plan.step)
    const admitted = admitFailureLogs({ plan, outcome })
    if (admitted.kind === 'complete') {
        // One diagnostic per log line buried the cause under dozens of near-identical errors.
        const { records } = admitted
        if (records.length === 0) return [ownerDiagnostic(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'bounded failure logs contained no records',
            service,
        )]
        return [ownerDiagnostic(ENVIRONMENT_CODES.EXECUTION_STEP_FAILED, failureLogExcerpt(service, records), service)]
    }
    return [ownerDiagnostic(
        'code' in admitted ? admitted.code : ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'code' in admitted ? 'failure log collection failed' : 'failure log output could not be admitted',
        'service' in admitted ? admitted.service : service,
    )]
}

function progressValueForPlan(value: LifecycleRecordValue): LifecycleProgress {
    return {
        workBasisSha256: value.workBasisSha256,
        operationGeneration: value.operationGeneration,
        completedServices: value.completedServices,
    }
}

type UpRoundResult =
    | { readonly kind: 'retry'; readonly forceReset: boolean }
    | { readonly kind: 'complete'; readonly result: UpCommandResult }

function matchesPortAcquisition(
    context: LifecycleRunContext,
    leaseResult: LeasePortFamilyResult,
    projection: PortLeaseProjection,
): leaseResult is Extract<LeasePortFamilyResult, { kind: 'complete' }> {
    try {
        return leaseResult.kind === 'complete'
            && leaseResult.lease.stackId === context.stackId
            && projection.lease.stackId === context.stackId
            && leaseResult.holderId === context.holderId
            && projection.ownership.holderId === context.holderId
            && leaseResult.change === projection.ownership.change
            && leaseResult.recordRevision === projection.ownership.recordRevision
            && JSON.stringify(leaseResult.lease) === JSON.stringify(projection.lease)
    } catch {
        // A throwing accessor in the lease result is a mismatch, which the caller refuses.
        return false
    }
}

function orderedRuntimeServices(topology: RuntimeTopologyEvidence): RuntimeTopologyEvidence['services'] | undefined {
    const order = resolveRuntimeServiceOrder(topology)
    const services = topology.services
    if (order.length === 0 || order.length !== services.length || new Set(order).size !== order.length) return undefined
    const byId = new Map(services.map((service) => [service.id, service] as const))
    if (byId.size !== services.length || order.some((serviceId) => !byId.has(serviceId))) return undefined
    return order.map((serviceId) => byId.get(serviceId)!)
}

async function executeUpRound(
    context: LifecycleRunContext,
    adapters: UpCommandAdapters,
    forceReset: boolean,
    rememberAcquisition: (value: LeasePortFamilyResult, projection: PortLeaseProjection) => void,
    rememberRuntimeStart: () => void,
    initialAcquisition: PortLeaseProjection | undefined,
): Promise<UpRoundResult> {
    const operate = async (runtime: RuntimeReadiness, stage: LifecycleStageProjection, ports: AcquiredPorts): Promise<UpRoundResult> => {
        // The floor is measured with the runtime readiness, so a machine below it is refused
        // before any service starts rather than discovered as a slow or failed start.
        const belowFloor = runtime.hostObservations.find((observation) => !observationSatisfiesExpectation(observation))
        if (belowFloor) return { kind: 'complete' as const, result: machineFloorRefusal(belowFloor) }
        const current = await readLifecycleRecord(context)
        if (current !== null && 'kind' in current && current.kind !== 'complete') {
            return { kind: 'complete' as const, result: current }
        }
        const stored = current as CurrentLifecycleRecord | null
        const teardownComplete = stored?.value.teardownComplete === true
        // The recorded inputs name what the stack was started from, and sleep keeps them, so a
        // stopped stack whose Compose files or runtime declarations changed is refused as a running
        // one is: `up` never recreates a recorded stack in place, and `down` removes it by its
        // ownership labels whatever the configuration says now.
        if (stored && !teardownComplete && stored.value.runtimeInputs !== undefined
            && !isDeepStrictEqual(stored.value.runtimeInputs, runtime.inputs)) {
            return { kind: 'complete' as const, result: runtimeChangedRefusal(context,
                changedRuntimeInputs(stored.value.runtimeInputs, runtime.inputs, basename(context.source.path))) }
        }
        if (teardownComplete) {
            const acquisition = initialAcquisition ?? (ports.leaseResult.kind === 'complete' && ports.leaseResult.change === 'acquired'
                ? inspectPortLeaseProjection(ports.projection, context.namespace) : undefined)
            const freshSoleHolder = acquisition !== undefined
                && inspectPortLeaseProjection(acquisition, context.namespace) === acquisition
                && acquisition.ownership.change === 'acquired'
                && acquisition.ownership.holderId === context.holderId
                && acquisition.ownership.holderCount === 1
                && acquisition.ownership.holderIds[0] === context.holderId
                && acquisition.ownership.recordRevision === ports.projection.ownership.recordRevision
                && ports.projection.ownership.holderCount === 1
                && ports.projection.ownership.holderIds[0] === context.holderId
                && await revalidatePortLeaseProjection({ projection: acquisition, namespace: context.namespace })
            const sourceCurrent = await withLifecycleConfiguration(context, async () => true)
            const currentProgress = await readLifecycleRecord(context)
            // This checkout already held the torn-down stack before this up claimed anything: a claim an
            // interrupted command left. Rerunning up meets the same claim, so only down releases it.
            const leftClaim = acquisition === undefined && ports.leaseResult.kind === 'complete' && ports.leaseResult.change !== 'acquired'
                && ports.projection.ownership.holderCount === 1 && ports.projection.ownership.holderIds[0] === context.holderId
            if (leftClaim) {
                return { kind: 'complete', result: lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
                    `this checkout still holds a claim on the stack down removed, left by an earlier command, so up cannot start it afresh; run \`${lifecycleSuggestion(context, 'down')}\` to release the claim, then \`${lifecycleSuggestion(context, 'up')}\``, context.stackId,
                    'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config <your cockpit.toml> to release the claim, then ./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config <your cockpit.toml>') }
            }
            if (!freshSoleHolder || !sourceCurrent || !currentProgress || 'status' in currentProgress
                || !isDeepStrictEqual(currentProgress.record, stored.record)
                || !await revalidatePortLeaseProjection({ projection: ports.projection, namespace: context.namespace })) {
                return { kind: 'complete', result: lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
                    `completed teardown requires unchanged configuration, lifecycle progress and a fresh sole-holder claim; rerun \`${lifecycleSuggestion(context, 'up')}\``, context.stackId,
                    'rerun ./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config <your cockpit.toml> once nothing else is changing cockpit.toml or bringing the stack up') }
            }
        }
        const resetProgress = forceReset || teardownComplete
        const completedServiceIds = stored ? new Set(stored.value.completedServices.map(({ service }) => service)) : undefined
        const progressComplete = stored !== null && completedServiceIds?.size === runtime.topology.services.length
            && runtime.topology.services.every(({ id }) => completedServiceIds.has(id))
        const previousHolderActive = stored !== null
            && ports.projection.ownership.holderIds.includes(stored.value.holderId)
        const currentHolderActive = ports.projection.ownership.holderIds.includes(context.holderId)
        const completedCoTenant = stored !== null && stored.value.holderId !== context.holderId && progressComplete
            && previousHolderActive && currentHolderActive
        if (stored && stored.value.holderId !== context.holderId
            && (previousHolderActive || !currentHolderActive) && !completedCoTenant) {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                `lifecycle progress belongs to another active session; run \`${lifecycleSuggestion(context, 'up')}\` to resume it or \`${lifecycleSuggestion(context, 'down')}\` to release it`,
                context.stackId,
            ) }
        }

        const operationGeneration = stored && !resetProgress
            ? stored.value.operationGeneration
            : randomBytes(32).toString('hex')
        const revalidateCompletedServices = async (): Promise<
            | Readonly<{ kind: 'complete'; evidence: readonly RuntimeServiceEvidence[] }>
            | Readonly<{ kind: 'retry' }>
            | Readonly<{ kind: 'refusal'; result: UpCommandResult }>
        > => {
            const evidence: RuntimeServiceEvidence[] = []
            if (!stored || resetProgress) return { kind: 'complete', evidence }
            for (const completed of stored.value.completedServices) {
                const admitted = await revalidateService(runtime.topology, completed, adapters)
                if (admitted.kind === 'stale') return { kind: 'retry' }
                if (admitted.kind !== 'complete') {
                    const logDiagnostics = await reportFailedService(admitted.logs, completed.service, context, adapters)
                    const primary = lifecycleRefusal(
                        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                        `completed runtime service could not be revalidated: its recorded container is no longer running and healthy, for example after it was killed — fix: run \`${cockpitCommand('sleep', { config: context.source.path })}\`, then \`${lifecycleSuggestion(context, 'up')}\` to start the stack again`,
                        completed.service,
                    )
                    return { kind: 'refusal', result: {
                        ...primary,
                        diagnostics: uniqueDiagnostics([...primary.diagnostics, ...logDiagnostics]),
                    } }
                }
                evidence.push(admitted.evidence)
            }
            return { kind: 'complete', evidence }
        }
        if (completedCoTenant) {
            const revalidated = await revalidateCompletedServices()
            if (revalidated.kind === 'retry') return { kind: 'complete', result: lifecycleRefusal(
                ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                'completed lifecycle progress belongs to an active holder but its runtime evidence is stale',
                context.stackId,
            ) }
            if (revalidated.kind === 'refusal') return { kind: 'complete', result: revalidated.result }
            return { kind: 'complete' as const, result: {
                kind: 'complete', status: 0, diagnostics: [],
                result: { stackId: context.stackId, change: 'unchanged', ports: ports.projection.lease.ports, entrypoints: ports.projection.entrypoints },
            } }
        }

        const admission = admitUpProgress({
            lifecycleStage: stage,
            runtime: runtime.lifecycle,
            ports: ports.projection,
            progress: stored && !resetProgress ? progressValueForPlan(stored.value) : null,
            operationGeneration,
        })
        if (admission.kind === 'refusal') {
            // A declaration edit shows only as changed work. Restarting it from scratch recreated
            // healthy containers under the new declaration, and stopped them when their labels no
            // longer matched; a fully started stack is refused instead. `up` never recreates a
            // running stack in place; `down` removes it by its ownership labels whatever the
            // configuration says now.
            if (stored && !resetProgress && progressComplete) {
                return { kind: 'complete' as const, result: runtimeChangedRefusal(context,
                    changedRuntimeInputs(stored.value.runtimeInputs, runtime.inputs, basename(context.source.path))) }
            }
            return stored && !resetProgress
                ? { kind: 'retry' as const, forceReset: true }
                : { kind: 'complete' as const, result: forwardedRefusal(admission.diagnostics) }
        }

        const revalidated = await revalidateCompletedServices()
        if (revalidated.kind === 'retry') return { kind: 'retry', forceReset: true }
        if (revalidated.kind === 'refusal') return { kind: 'complete', result: revalidated.result }
        let completedEvidence = [...revalidated.evidence]

        const planned = planAdmittedUp({ authority: admission.authority, completedServices: completedEvidence })
        if (planned.kind === 'refusal') {
            return stored && !resetProgress
                ? { kind: 'retry' as const, forceReset: true }
                : { kind: 'complete' as const, result: lifecycleRefusal(
                      ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                      'current lifecycle work could not be planned',
                      context.stackId,
                  ) }
        }
        const issuance = consumeLifecycleIssuance(planned.plan)
        if (!issuance || issuance.drainRequest !== null || issuance.reclaim !== null) {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'lifecycle plan authority is unavailable',
                context.stackId,
            ) }
        }
        const orderedServices = orderedRuntimeServices(issuance.topology)
        if (!orderedServices || issuance.firstIncompleteServiceIndex < 0
            || issuance.firstIncompleteServiceIndex > orderedServices.length) {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'runtime service dependency order is unavailable',
                context.stackId,
            ) }
        }
        let published = stored
        const startedEvidence: RuntimeServiceEvidence[] = []
        const plannedValue: LifecycleRecordValue = {
            holderId: context.holderId,
            ...planned.plan.progress,
            runtimeInputs: runtime.inputs,
            ...(runtime.activeProfiles.length > 0 ? { activeProfiles: runtime.activeProfiles } : {}),
        }
        if (!stored || resetProgress || stored.value.holderId !== context.holderId && !completedCoTenant) {
            // The first lifecycle data starts its durable history, as `setup` does (an existing
            // `started` is unchanged), so lifecycle data without history keeps meaning that history
            // was lost. Publishing data alone let a first `up` pass and every resume refuse.
            if (!stored) {
                const started = await recordLifecycleStarted({ namespace: context.namespace, stackId: context.stackId,
                    holderId: context.holderId, observedAt: new Date().toISOString() })
                if (started.kind === 'refusal') return { kind: 'complete' as const, result: forwardedRefusal(started.diagnostics) }
            }
            const publication = await publishLifecycleRecord(
                context,
                stored?.record ?? null,
                plannedValue,
                stored && stored.value.holderId !== context.holderId
                    ? { previousHolderId: stored.value.holderId, projection: ports.projection }
                    : undefined,
                teardownComplete ? ports.projection : undefined,
            )
            if ('status' in publication) return { kind: 'complete' as const, result: publication }
            if (publication.kind === 'indeterminate') return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
                publication.message,
                publication.target,
            ) }
            if (publication.kind !== 'complete') return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                'lifecycle progress publication returned no record',
                context.stackId,
            ) }
            published = decodeLifecycleRecord(publication.value, context) ?? null
            if (!published) return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                'published lifecycle progress is malformed',
                context.stackId,
            ) }
        }
        if (planned.kind === 'noop') {
            return { kind: 'complete' as const, result: {
                kind: 'complete', status: 0, diagnostics: planned.plan.diagnostics,
                result: { stackId: context.stackId, change: 'unchanged', ports: ports.projection.lease.ports, entrypoints: ports.projection.entrypoints },
            } satisfies UpCommandResult }
        }
        for (let index = issuance.firstIncompleteServiceIndex; index < orderedServices.length; index += 1) {
            const service = orderedServices[index]!
            ports.retainOnFailure()
            rememberRuntimeStart()
            const admitted = await startService(issuance.topology, service.id, adapters)
            if (admitted.kind !== 'complete') {
                const logDiagnostics = await reportFailedService(
                    admitted.kind === 'failure' ? admitted.logs : undefined,
                    service.id,
                    context,
                    adapters,
                    admitted.kind === 'failure' ? admitted.stop : undefined,
                )
                const primary = lifecycleRefusal(
                    ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                    'runtime service did not become healthy',
                    service.id,
                )
                return { kind: 'complete' as const, result: {
                    ...primary,
                    diagnostics: uniqueDiagnostics([...primary.diagnostics, ...logDiagnostics]),
                } }
            }
            completedEvidence.push(admitted.evidence)
            startedEvidence.push(admitted.evidence)
            const nextValue: LifecycleRecordValue = {
                ...plannedValue,
                completedServices: [
                    ...published!.value.completedServices,
                    { service: admitted.evidence.service, containerId: admitted.evidence.containerId },
                ],
            }
            const publication = await publishLifecycleRecord(context, published!.record, nextValue)
            if ('status' in publication) return { kind: 'complete' as const, result: publication }
            if (publication.kind === 'indeterminate') return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
                publication.message,
                publication.target,
            ) }
            if (publication.kind !== 'complete') return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                'lifecycle progress publication returned no record',
                context.stackId,
            ) }
            published = decodeLifecycleRecord(publication.value, context) ?? null
            if (!published) return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                'published lifecycle progress is malformed',
                context.stackId,
            ) }
        }
        const coldStartObservation = observeRuntimeServiceColdStart({ services: startedEvidence })
        if (coldStartObservation.observed.state !== 'available'
            || typeof coldStartObservation.observed.value !== 'number'
            || coldStartObservation.expectation.kind !== 'maximum') {
            return { kind: 'complete' as const, result: lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'runtime cold-start evidence is unavailable',
                context.stackId,
            ) }
        }
        if (!observationSatisfiesExpectation(coldStartObservation)) {
            return { kind: 'complete' as const, result: { kind: 'refusal', status: 2, result: null, diagnostics: [{
                severity: 'error',
                code: 'MACHINE_COLD_START_EXCEEDED' satisfies typeof ENVIRONMENT_CODES.MACHINE_COLD_START_EXCEEDED,
                message: `the runtime took ${seconds(coldStartObservation.observed.value)} s to start its services, over the `
                    + `${seconds(coldStartObservation.expectation.value)} s that environment.machine.cold_start_seconds allows`,
                target: coldStartObservation.source,
                fix: 'make the services start faster, or raise environment.machine.cold_start_seconds in cockpit.toml above the measured time and run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>; then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config <your cockpit.toml> and ./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config <your cockpit.toml>',
            }] } }
        }
        const coldStart = {
            measuredMillis: coldStartObservation.observed.value,
            limitMillis: coldStartObservation.expectation.value,
            headroomMillis: coldStartObservation.expectation.value - coldStartObservation.observed.value,
        }
        return { kind: 'complete' as const, result: {
            kind: 'complete', status: 0, diagnostics: planned.plan.diagnostics,
            result: {
                stackId: context.stackId,
                change: planned.mode === 'start' ? 'started' : 'resumed',
                ports: ports.projection.lease.ports,
                entrypoints: ports.projection.entrypoints,
                coldStart,
            },
        } satisfies UpCommandResult }
    }
    const unavailable = () => ({ kind: 'complete' as const, result: lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'lifecycle, port or runtime readiness authority is unavailable', context.stackId,
    ) })
    const refused: ReadinessRefusal<UpRoundResult> = (diagnostics) => ({
        kind: 'complete',
        result: forwardedRefusal(diagnostics.map((diagnostic) => diagnostic.code === ENVIRONMENT_CODES.CLAIM_CO_TENANT
            ? ownerDiagnostic(diagnostic.code,
                `lifecycle progress belongs to another active session; run \`${lifecycleSuggestion(context, 'up')}\` to resume it or \`${lifecycleSuggestion(context, 'down')}\` to release it`,
                diagnostic.target ?? context.stackId)
            : diagnostic)),
    })
    return await adapters.withLifecycleStage(context, async (stage) => await adapters.withAcquiredPorts(context, async (ports) => {
            if (!matchesPortAcquisition(context, ports.leaseResult, ports.projection)) {
                return { kind: 'complete' as const, result: lifecycleRefusal(
                    ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                    'port acquisition does not match the current lifecycle authority',
                    context.stackId,
                ) }
            }
            const outcome = await adapters.withRuntimeReadiness(context,
                (runtime) => operate(runtime, stage, ports), ports.projection, refused) ?? unavailable()
            rememberAcquisition(ports.leaseResult, ports.projection)
            return outcome
        }, refused) ?? unavailable(), refused) ?? unavailable()
}

export async function runUp(
    input: UpCommandInput,
    adapters: UpCommandAdapters,
): Promise<UpCommandResult> {
    const configPath = exactCommandConfigPath(input)
    if (!configPath) return lifecycleContextRefusal()
    const loaded = await adapters.load({ configPath })
    if (loaded.kind === 'refusal') return loaded
    if (loaded.kind === 'preview') return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'lifecycle run context was not fully resolved',
        input.configPath,
    )
    if (loaded.result.configPath !== configPath || !issuedLifecycleRuns.delete(loaded.result)) {
        return lifecycleRefusal(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'lifecycle run authority is unavailable',
            configPath,
        )
    }
    const context = loaded.result
    return withLifecycleRunNotices(context, await upWithContext(context, adapters))
}

async function upWithContext(context: LifecycleRunContext, adapters: UpCommandAdapters): Promise<UpCommandResult> {
    type AcquiredLeaseResult = Extract<LeasePortFamilyResult, { kind: 'complete' }> & { readonly change: 'acquired' }
    let acquired: AcquiredLeaseResult | undefined
    let initialAcquisition: PortLeaseProjection | undefined
    const rememberAcquisition = (lease: LeasePortFamilyResult, projection: PortLeaseProjection) => {
        if (!acquired && lease.kind === 'complete' && lease.change === 'acquired') {
            acquired = lease as AcquiredLeaseResult
            initialAcquisition = inspectPortLeaseProjection(projection, context.namespace)
        }
    }
    // The holder claim and its lease are what own the stack's runtime: `down` and `reset` act only
    // for a holder, and the next `up` resumes from the holder's durable progress. Once this `up`
    // has asked Compose to start a service, containers may exist on the leased ports, so a refusal
    // keeps the claim rather than compensating it. Releasing it orphaned those containers: the
    // next `up` leased the same family and collided with its own ports, and `down` had no holder.
    let runtimeStarted = false
    const rememberRuntimeStart = () => { runtimeStarted = true }
    const releasable = () => acquired !== undefined && !runtimeStarted
    const declaration = await inspectRecordedPortDeclaration({ namespace: context.namespace, stackId: context.stackId, config: context.ports })
    if (declaration.kind === 'refusal') return forwardedRefusal(declaration.diagnostics)
    if (declaration.changed) return runtimeChangedRefusal(context, `[ports] in ${basename(context.source.path)} changed since it started`)
    // Starting under the new name beside a stack recorded under the old one would run two stacks for
    // one checkout, the old one beyond the reach of down.
    const earlier = await findStackUnderEarlierName({ namespace: context.namespace, cockpitId: context.cockpitId, checkoutId: context.checkoutId })
    if (earlier.kind === 'refusal') return lifecycleRefusal(earlier.code, earlier.message, earlier.target)
    if (earlier.name !== undefined) return lifecycleRefusal(ENVIRONMENT_CODES.STACK_RECORDED_UNDER_EARLIER_NAME,
        earlierNameRefusalMessage(context.source.path, earlier.name), context.stackId)
    let forceReset = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const round = await executeUpRound(context, adapters, forceReset, rememberAcquisition, rememberRuntimeStart, initialAcquisition)
        if (round.kind === 'retry') {
            forceReset = round.forceReset
            continue
        }
        let result = round.result
        if (result.kind === 'complete') {
            const seeded = await recordLifecycleSeeded({ namespace: context.namespace, stackId: context.stackId,
                holderId: context.holderId, observedAt: new Date().toISOString() })
            if (seeded.kind === 'refusal') return forwardedRefusal(seeded.diagnostics)
            // The stack stays up when its seed fails: the containers are healthy, and the next up
            // runs the seed again because no success was recorded.
            const data = await adapters.seed?.(context, result.result)
            if (data?.kind === 'refusal') return { kind: 'refusal', status: 2, result: null,
                diagnostics: uniqueDiagnostics([...result.diagnostics, ...data.diagnostics]) }
            if (data?.kind === 'ran' || data?.kind === 'current') result = { ...result, result: { ...result.result, seed: data.kind } }
            const unrecorded = await adapters.recordStackInputs?.(context, result.result.change) ?? []
            if (unrecorded.length > 0) result = { ...result, diagnostics: uniqueDiagnostics([...result.diagnostics, ...unrecorded]) }
        }
        if (result.kind === 'refusal' && releasable()) {
            const compensation = await compensateAcquiredPortHolder({
                namespace: context.namespace,
                leaseResult: acquired!,
                now: new Date().toISOString(),
            })
            if (compensation.kind === 'refusal') return {
                ...result,
                diagnostics: uniqueDiagnostics([...result.diagnostics, ...compensation.diagnostics]),
            }
        }
        return result
    }
    if (releasable()) {
        const compensation = await compensateAcquiredPortHolder({
            namespace: context.namespace,
            leaseResult: acquired!,
            now: new Date().toISOString(),
        })
        if (compensation.kind === 'refusal') {
            const primary = lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
                'lifecycle progress could not be reset from fresh evidence',
                context.stackId,
            )
            return {
                ...primary,
                diagnostics: uniqueDiagnostics([...primary.diagnostics, ...compensation.diagnostics]),
            }
        }
    }
    return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
        'lifecycle progress could not be reset from fresh evidence',
        context.stackId,
    )
}

// The wrapped agent reaches the stack the way its Compose files do: each `[ports.bases]` name holds
// the leased port, and each entrypoint `up --json` reports is under COCKPIT_ENTRYPOINT_<NAME>.
// Without them a command such as `curl "http://127.0.0.1:$API_HOST_PORT/"` falls back to port 80.
// The lease is the truth for this stack, so it replaces a value the caller's shell already set.
function sessionChildEnvironment(
    env: Readonly<Record<string, string>>,
    up: Extract<UpCommandResult, { kind: 'complete' }>['result'],
): Readonly<Record<string, string>> {
    return {
        ...env,
        ...Object.fromEntries(Object.entries(up.ports).map(([name, port]) => [name, String(port)])),
        ...Object.fromEntries(up.entrypoints.map(({ name, value }) =>
            [`COCKPIT_ENTRYPOINT_${name.toUpperCase().replaceAll('-', '_')}`, value])),
    }
}

// A session over a stack an earlier up still holds ends with the containers running, which read as a
// failed release when nothing said why. Literals, so the diagnostic inventory captures the fix.
function sessionStackRetained(stackId: string) {
    return {
        severity: 'info' as const,
        code: 'SESSION_STACK_RETAINED' as const satisfies typeof ENVIRONMENT_CODES.SESSION_STACK_RETAINED,
        message: 'the session released its hold, and the stack keeps running because another holder, such as an earlier up from this checkout, still holds it',
        target: stackId,
        fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sleep --config <your cockpit.toml> to release this checkout\'s remaining hold',
    }
}

export async function runSession(
    input: SessionCommandInput,
    adapters: SessionCommandAdapters,
): Promise<SessionCommandResult> {
    if (adapters.signal?.aborted) return {
        kind: 'refusal' as const, status: 130 as const, result: null,
        diagnostics: [{ severity: 'error' as const, code: ENVIRONMENT_CODES.EXECUTION_ABORTED,
            message: 'the supervised session was cancelled before environment bring-up', target: input.argv[0] }],
    }
    // A relative command path such as `./node_modules/.bin/tool` names a file under the directory the
    // session runs in, so it resolves there; one that climbs out of it is refused rather than guessed.
    const argv0 = input.argv[0]
    const relativePath = !isAbsolute(argv0) && argv0.includes('/')
    const commandPath = relativePath ? resolve(input.cwd, argv0) : argv0
    if (relativePath && !commandPath.startsWith(`${input.cwd}${sep}`)) return lifecycleRefusal(
        ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        `the command path resolves to ${commandPath}, outside the session working directory ${input.cwd}; give an absolute path or a PATH entry name`,
        argv0,
        'name the command after -- by an absolute path, a path inside the session working directory, or a name found on PATH',
    )
    const executable = await adapters.resolveExecutable(commandPath, input.env)
    if (executable.state === 'unavailable') return lifecycleRefusal(
        ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        executable.reason,
        input.argv[0],
        'name the command after -- by an absolute path, a path inside the session working directory, or a name found on PATH',
    )
    const up = await adapters.up({ configPath: input.configPath })
    if (up.kind === 'refusal') return up
    if (up.kind !== 'complete') return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'session bring-up did not reach a terminal result',
        input.configPath,
    )

    const child = await adapters.executeForeground({
        executable: executable.value,
        argv: input.argv.slice(1),
        cwd: input.cwd,
        env: sessionChildEnvironment(input.env, up.result),
    }, { ...(adapters.signal ? { signal: adapters.signal } : {}) })
    if (!child.terminationConfirmed) return lifecycleRefusal(
        ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED,
        'the owned session process group could not be confirmed stopped; lifecycle ownership was preserved',
        input.argv[0],
    )

    const sleep = await adapters.sleep({ configPath: input.configPath })
    // The sleep change names what happened to the stack, not to the session's hold, which every
    // completed cleanup released; "cleanup retained" read as the hold having been kept.
    const cleanup = sleep.kind !== 'complete' ? ''
        : sleep.result.change === 'stopped' ? '; its hold was released and the stack stopped'
            : sleep.result.change === 'retained' ? '; its hold was released and another holder keeps the stack running'
                : '; its hold was released'
    // A command that exits nonzero is a normal end of the session, not a cockpit failure: a wrapper
    // that exits 2 for it hides the command's own status from the scripts and agents that branch on
    // it. So a completed cleanup passes that status through, with the shell convention of 128 plus
    // the signal number for a signalled command, and only a failed cleanup exits 2.
    const signalNumber = child.kind === 'complete' && child.signal ? osConstants.signals[child.signal] : undefined
    const childStatus = child.kind !== 'complete' ? 2
        : signalNumber !== undefined ? 128 + signalNumber : child.exitCode
    const childDiagnostic = child.kind === 'refusal'
        ? { severity: 'error' as const, code: child.code,
            message: `the supervised session process failed${cleanup}`, target: input.argv[0] }
        : childStatus === 0 ? undefined : {
            severity: 'error' as const, code: ENVIRONMENT_CODES.EXECUTION_STEP_FAILED,
            message: `the supervised session process ${child.signal ? `was terminated by ${child.signal}` : `exited with status ${child.exitCode}`}${cleanup}`,
            target: input.argv[0],
        }
    if (sleep.kind !== 'complete' || child.kind === 'refusal') return {
        kind: 'refusal', status: sleep.kind === 'complete' && child.kind === 'refusal'
            && child.code === ENVIRONMENT_CODES.EXECUTION_ABORTED ? 130 : 2, result: null,
        diagnostics: [
            ...(childDiagnostic ? [childDiagnostic] : []),
            ...sleep.diagnostics,
        ],
    }
    const retained = sleep.result.change === 'retained' ? [sessionStackRetained(sleep.result.stackId)] : []
    return {
        kind: 'complete' as const,
        status: childStatus,
        diagnostics: uniqueDiagnostics([...up.diagnostics, ...sleep.diagnostics, ...retained]),
        result: {
            child: { exitCode: child.exitCode, signal: child.signal },
            sleep: sleep.result,
        },
    }
}

export async function runSleep(
    input: SleepCommandInput,
    adapters: SleepCommandAdapters,
): Promise<SleepCommandResult> {
    const configPath = exactCommandConfigPath(input)
    if (!configPath) return lifecycleContextRefusal()
    const loaded = await adapters.load({ configPath })
    if (loaded.kind === 'refusal') return loaded
    if (loaded.kind === 'preview') return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'lifecycle run context was not fully resolved',
        input.configPath,
    )
    if (loaded.result.configPath !== configPath || !issuedLifecycleRuns.delete(loaded.result)) {
        return lifecycleRefusal(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'lifecycle run authority is unavailable',
            configPath,
        )
    }
    const context = loaded.result
    const outcome = await sleepWithContext(context, adapters)
    // A stopped stack runs nothing a later doctor could call stale.
    const forgotten = outcome.kind === 'complete' && outcome.result.change === 'stopped' ? await forgetStackInputs(dirname(context.source.path)) : []
    return withLifecycleRunNotices(context, forgotten.length === 0 ? outcome : { ...outcome, diagnostics: uniqueDiagnostics([...outcome.diagnostics, ...forgotten]) })
}

async function sleepWithContext(context: LifecycleRunContext, adapters: SleepCommandAdapters): Promise<SleepCommandResult> {
    let recovery = await inspectSleepDrainRecovery({
        namespace: context.namespace,
        stackId: context.stackId,
        holderId: context.holderId,
    })
    if (recovery.kind === 'repairable') {
        const terminated = await repairFencedExecution(recovery.fence)
        if (terminated.kind !== 'complete') return repairRequired(context)
        const repaired = await settleInterruptedDrainRepair({ namespace: context.namespace, record: recovery.record, evidence: terminated.evidence })
        if (repaired.kind !== 'complete') return repairRequired(context)
        if (!await cleanupFencedExecution(recovery.fence)) return lifecycleRefusal(
            ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
            'the interrupted sleep executor stopped but its durable execution fence could not be removed',
            recovery.fence.markerPath,
        )
        recovery = await inspectSleepDrainRecovery({ namespace: context.namespace, stackId: context.stackId, holderId: context.holderId })
    }
    if (recovery.kind === 'refusal') return {
        kind: 'refusal', status: 2, result: null,
        diagnostics: recovery.diagnostics.map((diagnostic) => diagnostic.code === ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED
            ? ownerDiagnostic(diagnostic.code,
                'cockpit cannot prove the interrupted sleep executor stopped, so it will not overlap it with another destructive action; preserve the coordination state for explicit repair',
                diagnostic.target ?? context.stackId)
            : diagnostic),
    }

    if (recovery.kind !== 'recoverable') {
        const reaped = await releaseDeadSessionHolders({
            namespace: context.namespace, stackId: context.stackId,
            successor: { holderId: context.holderId, checkoutId: context.checkoutId },
            now: new Date().toISOString(), observe: (pid) => observeProcessStart(pid, processHost(adapters.execute)),
        })
        if (reaped.kind === 'refusal') return forwardedRefusal(reaped.diagnostics)
    }
    const unheld = recovery.kind === 'recoverable' ? undefined : await unheldStack(context)
    if (unheld) return unheld
    const retained = await observeRetainedPortFamily({
        namespace: context.namespace,
        stackId: context.stackId,
        holderId: context.holderId,
        checkoutId: context.checkoutId,
        config: 'recorded',
    })
    if (retained.kind !== 'complete') return lifecycleRefusal(
        retained.diagnostics[0]?.code ?? ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        retained.diagnostics[0]?.message ?? 'retained port authority is unavailable',
        retained.diagnostics[0]?.target ?? context.stackId,
    )
    const entrypoints = deriveEntrypoints({
        lease: retained.lease,
        declarations: context.entrypointDerivatives,
    })
    if (entrypoints.kind !== 'complete') return lifecycleRefusal(
        entrypoints.diagnostics[0]?.code ?? ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        entrypoints.diagnostics[0]?.message ?? 'entrypoint authority is unavailable',
        entrypoints.diagnostics[0]?.target ?? context.stackId,
    )
    const ports = await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })
    if (!ports) return lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'retained port projection is unavailable',
        context.stackId,
    )
    const result = await adapters.withRuntimeReadiness(context, async (runtime) => {
        const generation = recovery.kind === 'recoverable'
            ? recovery.generation : randomBytes(32).toString('hex')
        const planned = planSleep({
            runtime: runtime.lifecycle,
            ports,
            operationGeneration: generation,
            runtimeStopValidForMs: recovery.kind === 'recoverable'
                ? recovery.runtimeStopValidForMs : 60_000,
        })
        if (planned.kind === 'refusal') return {
            kind: 'refusal' as const, status: 2 as const, result: null,
            diagnostics: planned.diagnostics,
        }
        const issuance = consumeLifecycleIssuance(planned.plan)
        if (!issuance || issuance.reclaim !== null || issuance.portOwnership.holderId !== context.holderId) {
            return lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'sleep lifecycle authority is unavailable',
                context.stackId,
            )
        }
        if (planned.kind === 'release-only') {
            if (recovery.kind === 'recoverable') return lifecycleRefusal(
                ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
                'persisted lifecycle work no longer matches current ownership',
                context.stackId,
            )
            const released = await releasePortFamily({
                namespace: context.namespace,
                stackId: context.stackId,
                requesterId: context.holderId,
                holderId: context.holderId,
                now: new Date().toISOString(),
            })
            if (released.kind !== 'complete' || released.change !== 'retained') return lifecycleRefusal(
                ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                'shared lifecycle ownership changed before release',
                context.stackId,
            )
            return {
                kind: 'complete' as const, status: 0 as const, diagnostics: planned.plan.diagnostics,
                result: { stackId: context.stackId, change: 'retained' as const },
            }
        }
        if (!issuance.drainRequest) return lifecycleRefusal(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'sleep drain authority is unavailable',
            context.stackId,
        )
        let reserved
        if (recovery.kind === 'recoverable') {
            reserved = await recoverSleepDrainReservation({
                namespace: context.namespace,
                record: recovery.record,
                request: planned.request,
            })
        } else {
            reserved = await reserveDrain({ namespace: context.namespace, request: planned.request })
        }
        if (reserved.kind !== 'complete') return lifecycleRefusal(
            reserved.diagnostics[0]?.code ?? ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            reserved.diagnostics[0]?.message ?? 'sleep drain could not be reserved',
            reserved.diagnostics[0]?.target ?? context.stackId,
        )
        const attempted = await reserveDrainAttempt({ namespace: context.namespace, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') return lifecycleRefusal(
            attempted.diagnostics[0]?.code ?? ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            attempted.diagnostics[0]?.message ?? 'sleep attempt could not be reserved',
            attempted.diagnostics[0]?.target ?? context.stackId,
        )
        const stopped = await stopRuntime({ topology: issuance.topology, attempt: attempted, execute: (step) => adapters.execute(step) })
        if (stopped.kind === 'unavailable') return repairRequired(context)
        const { outcome, fence } = stopped
        if (stopped.kind === 'not-started') {
            const finalized = await publishDrainOutcome(context, outcome, fence)
            return finalized ?? lifecycleRefusal(stopped.code, 'runtime stop did not start', context.stackId)
        }
        const invalidated = await invalidateCompletedLifecycle(
            context,
            planned.request.operationBasis,
            planned.request.generation,
            'sleep',
        )
        if (invalidated) return invalidated
        const finalized = await publishDrainOutcome(context, outcome, fence)
        if (finalized) return finalized
        return {
            kind: 'complete' as const, status: 0 as const, diagnostics: planned.plan.diagnostics,
            result: { stackId: context.stackId, change: 'stopped' as const },
        }
    }, ports, forwardedRefusal, 'teardown')
    return result ?? lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'runtime readiness authority is unavailable',
        context.stackId,
    )
}
