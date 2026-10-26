import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import { loadCockpitConfig } from '../config/load.js'
import { snapshotExecutionStep, type CheckoutId, type CockpitId, type HolderId, type StackId } from './contract.js'
import {
    admitDependencyRuntime,
    createDependencyRuntimePlan,
} from './dependency-runtime.js'
import { resolveDockerExecutable } from './executable.js'
import { inspectGeneratedEnvironment, renderGeneratedEnvironment } from './generated-stack.js'
import { planInstall, verifyInstall, type PlanInstallInput } from './installs.js'
import {
    admitRuntimeServiceHealth,
    admitRuntimeServiceObservation,
    admitRuntimeServiceStageOutcome,
    admitRuntimeTopology,
    createRuntimeAdapter,
    createRuntimeServiceHealthPlan,
    createRuntimeServicePlan,
    createRuntimeTopologyPlan,
    observeDockerRuntime,
    projectDependencyRuntime,
} from './runtime.js'
import { selectStateRoot } from './state.js'

const evidencePath = '/tmp/b0-native-dependency-runtime-evidence.json'
const timeoutMs = 120_000
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function unavailable(reason: string) {
    return Object.freeze({
        version: 1,
        cell: 'native-dependency-runtime',
        kind: 'unavailable' as const,
        code: 'DEPENDENCY_RUNTIME_OPERATOR_INPUT_UNAVAILABLE',
        reason,
        generatedAdmission: false,
        candidate: false,
        unmountedControl: false,
        incompatibleAbiControl: false,
        cleanup: { survivors: ['not-run'] },
    })
}

async function persist(value: object) {
    await writeFile(evidencePath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

describe('generated dependency runtime', () => {
    it('runs one authenticated mounted candidate beside unmounted and incompatible-ABI controls when operator inputs exist', async () => {
        const requestedConfig = process.env.B0_DEPENDENCY_RUNTIME_CONFIG
        const requestedCheckout = process.env.B0_DEPENDENCY_RUNTIME_CHECKOUT
        const muslImage = process.env.B0_DEPENDENCY_RUNTIME_MUSL_IMAGE
        if (!requestedConfig || !requestedCheckout || !muslImage) {
            const evidence = unavailable('set the config, checkout, and pinned musl image inputs for the bounded native dependency batch')
            await persist(evidence)
            expect(evidence).toMatchObject({ kind: 'unavailable', candidate: false, unmountedControl: false, incompatibleAbiControl: false })
            return
        }
        if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(muslImage)) {
            const evidence = unavailable('the musl control image must be an exact pinned digest')
            await persist(evidence)
            expect(evidence.kind).toBe('unavailable')
            return
        }

        let configPath: string
        let checkout: string
        try {
            configPath = await realpath(requestedConfig)
            checkout = await realpath(requestedCheckout)
            if (!(await stat(configPath)).isFile() || !(await stat(checkout)).isDirectory()) throw new Error('wrong-kind')
        } catch {
            const evidence = unavailable('the operator config and checkout must be readable canonical paths')
            await persist(evidence)
            expect(evidence.kind).toBe('unavailable')
            return
        }

        const loaded = await loadCockpitConfig(configPath)
        const declaration = loaded.kind === 'complete' ? loaded.result.config.environment.generated : undefined
        if (loaded.kind !== 'complete' || !declaration) {
            const evidence = unavailable('the operator config has no admitted generated environment')
            await persist(evidence)
            expect(evidence.kind).toBe('unavailable')
            return
        }
        const config = loaded.result.config
        const policy = config.environment.install_policies.length === 1
            ? config.environment.install_policies[0]
            : undefined
        const service = policy && declaration.services.find((candidate) => candidate.mounts.some((mount) => mount.kind === 'volume' && mount.source === policy.volume))
        if (!policy || !service || policy.install.length === 0 || policy.load_probe.length === 0) {
            const evidence = unavailable('the generated environment has no service bound to the selected install policy volume')
            await persist(evidence)
            expect(evidence.kind).toBe('unavailable')
            return
        }
        const installCommand = [policy.install[0]!, ...policy.install.slice(1)] as [string, ...string[]]
        const loadCommand = [policy.load_probe[0]!, ...policy.load_probe.slice(1)] as [string, ...string[]]

        const configBytes = await readFile(configPath)
        const sourceSha256 = sha256(configBytes)
        const generation = sha256(Buffer.concat([configBytes, Buffer.from('\0native-dependency-runtime')]))
        const stack = `stack:${sha256(generation)}` as StackId
        const cockpit = `cockpit:native-dependency:${sha256(sourceSha256)}`
        const rendered = renderGeneratedEnvironment({
            declaration,
            sourceSha256,
            generation,
            stackId: stack,
            cockpitId: cockpit,
            portDefaults: config.ports.bases,
            siblingDirectories: Object.fromEntries(config.sibling.map((entry) => [entry.slug, entry.dir])),
        })
        if (rendered.kind !== 'complete'
            || inspectGeneratedEnvironment({ rendered, candidates: rendered.manifest.map(({ path, bytes }) => ({ path, bytes })), now: new Date().toISOString().slice(0, 10) }).kind !== 'passed') {
            const evidence = unavailable('generated-stack admission refused the operator declaration')
            await persist(evidence)
            expect(evidence.kind).toBe('unavailable')
            return
        }
        const composePath = resolve(checkout, declaration.compose_file)
        let composeBytes: Buffer
        try {
            composeBytes = await readFile(composePath)
        } catch {
            const evidence = unavailable('the exact generated Compose artifact is absent from the operator checkout')
            await persist(evidence)
            expect(evidence.kind).toBe('unavailable')
            return
        }
        if (!composeBytes.equals(Buffer.from(rendered.compose))) {
            const evidence = unavailable('the operator Compose artifact does not match the admitted generated bytes')
            await persist(evidence)
            expect(evidence.kind).toBe('unavailable')
            return
        }

        const runtimeEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
        const resolvedDocker = await resolveDockerExecutable(runtimeEnv)
        if (resolvedDocker.state !== 'available') {
            const evidence = unavailable(resolvedDocker.reason)
            await persist(evidence)
            expect(evidence.kind).toBe('unavailable')
            return
        }
        const observedRuntime = await observeDockerRuntime({ executable: resolvedDocker.value, cwd: checkout, env: runtimeEnv, timeoutMs: 30_000 }, executeProbe)
        if (observedRuntime.kind !== 'complete') {
            const evidence = unavailable(observedRuntime.reason)
            await persist(evidence)
            expect(evidence.kind).toBe('unavailable')
            return
        }

        const batchId = sha256(randomBytes(32))
        const profiles = [...new Set(declaration.services.flatMap((entry) => entry.profiles))].sort()
        const expectedMountSources = [...new Set(declaration.services.flatMap((entry) => entry.mounts
            .filter((mount) => mount.kind !== 'volume')
            .map((mount) => normalize(resolve(checkout, mount.source)))))].sort()
        const composeArtifact = { reference: declaration.compose_file, canonicalPath: composePath, source: rendered.compose, sha256: sha256(rendered.compose) }
        const projectPrefix = `b0-dependency-${batchId.slice(0, 12)}`
        const ownedVolumes = new Set<string>()
        const cleanupFailures: string[] = []

        const adapter = (projectName: string, operation: 'validate' | 'up' | 'down') => createRuntimeAdapter({
            runtime: { name: 'docker', version: observedRuntime.runtime.version, executableSha256: resolvedDocker.value.sha256 },
            composeVersion: observedRuntime.composeVersion,
            executable: resolvedDocker.value,
            operation,
            cwd: checkout,
            composeFiles: [composeArtifact],
            projectName,
            env: runtimeEnv,
            ports: [],
            labels: { stackId: stack, configSha256: sourceSha256, batchId },
            timeoutMs,
            activeProfiles: profiles,
            stackId: stack,
            coldStartLimitMillis: timeoutMs,
            expectedMountSources,
        })
        const executeAdapter = async (projectName: string, operation: 'validate' | 'up' | 'down') => {
            const planned = adapter(projectName, operation)
            if (planned.kind !== 'preview') return undefined
            return executeProbe(planned.plan.steps[0]!)
        }
        const establish = async (projectName: string) => {
            const up = await executeAdapter(projectName, 'up')
            if (up?.kind !== 'complete') return undefined
            const validation = adapter(projectName, 'validate')
            if (validation.kind !== 'preview') return undefined
            const now = Date.now()
            const topologyPlan = createRuntimeTopologyPlan({
                runtimePlan: validation.plan,
                stackId: stack,
                configSha256: sourceSha256,
                batchId,
                observationWindow: { startedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 299_000).toISOString() },
            })
            if (topologyPlan.kind !== 'planned') return undefined
            const topology = admitRuntimeTopology({ plan: topologyPlan, outcome: await executeProbe(topologyPlan.step) })
            if (topology.kind !== 'complete') return undefined
            const servicePlan = createRuntimeServicePlan({ topology: topology.topology, service: service.id })
            if (servicePlan.kind !== 'planned') return undefined
            const startOutcome = await executeProbe(servicePlan.start)
            if (admitRuntimeServiceStageOutcome({ plan: servicePlan, stage: 'start', outcome: startOutcome }).kind !== 'admitted') return undefined
            const statusOutcome = await executeProbe(servicePlan.status)
            if (admitRuntimeServiceStageOutcome({ plan: servicePlan, stage: 'status', outcome: statusOutcome, startOutcome }).kind !== 'admitted') return undefined
            const identityOutcome = await executeProbe(servicePlan.identity)
            if (admitRuntimeServiceStageOutcome({ plan: servicePlan, stage: 'identity', outcome: identityOutcome, startOutcome, statusOutcome }).kind !== 'admitted') return undefined
            const healthPlan = createRuntimeServiceHealthPlan({ plan: servicePlan, startOutcome, outcome: statusOutcome, identityOutcome })
            if (healthPlan.kind !== 'planned') return undefined
            const observed = admitRuntimeServiceObservation({ plan: healthPlan, outcome: await executeProbe(healthPlan.step) })
            if (observed.kind !== 'complete') return undefined
            const healthy = admitRuntimeServiceHealth({ observation: observed.observation })
            if (healthy.kind !== 'complete') return undefined
            const projection = projectDependencyRuntime({ topology: topology.topology, evidence: healthy.evidence, service: service.id, volume: policy.volume })
            if (!projection) return undefined
            const runtimePlan = createDependencyRuntimePlan({ runtime: projection })
            if (runtimePlan.kind !== 'planned') return undefined
            const admitted = admitDependencyRuntime({
                plan: runtimePlan,
                inspectOutcome: await executeProbe(runtimePlan.inspect),
                architectureOutcome: await executeProbe(runtimePlan.architecture),
                abiOutcome: await executeProbe(runtimePlan.abi),
            })
            if (admitted.kind !== 'complete') return undefined
            for (const entry of topology.topology.services.flatMap((item) => item.namedVolumeMounts ?? [])) ownedVolumes.add(entry.name)
            return { topology: topology.topology, evidence: healthy.evidence, admitted }
        }
        const dockerStep = (id: string, argv: readonly string[]) => snapshotExecutionStep({
            id,
            argv: [resolvedDocker.value.canonicalPath, ...argv] as [string, ...string[]],
            argv0: resolvedDocker.value.invocationPath,
            cwd: checkout,
            env: runtimeEnv,
            timeoutMs,
            stdoutLimitBytes: 1_048_576,
            stderrLimitBytes: 1_048_576,
            paths: [], ports: [], labels: { stackId: stack, batchId }, expected: [],
            consumedFiles: [{ path: resolvedDocker.value.canonicalPath, sha256: resolvedDocker.value.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: resolvedDocker.value.executionMode }],
            filesystemChecks: [], compensation: [],
        })

        let candidate = false
        let unmountedControl = false
        let incompatibleAbiControl = false
        let batchFailure: string | null = null
        const projects = [`${projectPrefix}-candidate`]
        const stateHome = await mkdtemp(join(tmpdir(), 'cockpit-native-dependency-'))
        try {
            const candidateRuntime = await establish(projects[0]!)
            if (!candidateRuntime) throw new Error('candidate-runtime-unavailable')
            const state = await selectStateRoot({ platform: 'linux', home: stateHome, cockpitId: cockpit as CockpitId })
            if (state.kind !== 'complete') throw new Error('state-unavailable')
            await mkdir(state.value.root, { recursive: true })
            const helperPath = resolve('packages/cockpit/libexec/install-filesystem.cjs')
            const helperBytes = await readFile(helperPath)
            const nodePath = await realpath(process.execPath)
            const nodeBytes = await readFile(nodePath)
            const installInput = (runtime: typeof candidateRuntime.admitted.binding): PlanInstallInput => ({
                checkoutId: `checkout:${sha256(checkout)}` as CheckoutId,
                holderId: `holder:${sha256(batchId)}:session` as HolderId,
                pid: process.pid,
                checkoutRoot: checkout,
                lockfilePath: resolve(checkout, policy.lockfile),
                state: state.value,
                runtime,
                policy: { volume: policy.volume, lockfile: policy.lockfile, install: installCommand, load_probe: loadCommand },
                executables: {
                    node: { canonicalPath: nodePath, invocationPath: nodePath, sha256: sha256(nodeBytes), executionMode: 'verified-path' },
                    helper: { path: helperPath, sha256: sha256(helperBytes) },
                },
                execution: { env: {}, installTimeoutMs: timeoutMs, probeTimeoutMs: timeoutMs, helperTimeoutMs: 30_000, stdoutLimitBytes: 1_048_576, stderrLimitBytes: 1_048_576 },
                observeHolder: async () => 'unknown',
            })
            const planned = await planInstall(installInput(candidateRuntime.admitted.binding), { execute: executeProbe })
            const installed = planned.kind === 'complete' ? await verifyInstall(planned, { execute: executeProbe }) : undefined
            candidate = installed?.kind === 'complete' && installed.disposition === 'installed'
            if (!candidate) throw new Error('candidate-install-unavailable')
            unmountedControl = projectDependencyRuntime({
                topology: candidateRuntime.topology,
                evidence: candidateRuntime.evidence,
                service: service.id,
                volume: `${policy.volume}-absent`,
            }) === undefined
            const topologyService = candidateRuntime.topology.services.find((entry) => entry.id === service.id)
            if (!topologyService) throw new Error('candidate-topology-unavailable')
            const controlMounts = service.mounts.flatMap((mount) => {
                if (mount.kind === 'volume') {
                    const named = topologyService.namedVolumeMounts?.find((entry) => entry.source === mount.source && entry.target === mount.target)
                    if (!named) throw new Error('candidate-volume-unavailable')
                    return ['--mount', `type=volume,src=${named.name},dst=${mount.target}`]
                }
                const source = normalize(resolve(checkout, mount.source))
                return ['--mount', `type=bind,src=${source},dst=${mount.target}${mount.kind === 'environment-file' ? ',readonly' : ''}`]
            })
            const populate = dockerStep('dependency-runtime:musl-populate', [
                'run', '--rm', ...controlMounts,
                '--workdir', candidateRuntime.admitted.compatibility.target, muslImage, ...installCommand,
            ])
            if (!populate || (await executeProbe(populate)).kind !== 'complete') throw new Error('musl-population-unavailable')
            const incompatibleRuntime = await establish(projects[0]!)
            if (!incompatibleRuntime) throw new Error('incompatible-runtime-unavailable')
            const reuse = await planInstall(installInput(incompatibleRuntime.admitted.binding), { execute: executeProbe })
            if (reuse.kind !== 'complete' || reuse.disposition !== 'reuse') throw new Error('incompatible-reuse-unavailable')
            let actualLoadFailure = false
            const refused = await verifyInstall(reuse, { execute: async (step) => {
                const outcome = await executeProbe(step)
                if (step === reuse.loadProbeStep) {
                    actualLoadFailure = outcome.kind === 'refusal'
                        && outcome.code === 'EXECUTION_STEP_FAILED'
                        && outcome.execution.started
                        && outcome.execution.exitCode > 0
                }
                return outcome
            } })
            incompatibleAbiControl = actualLoadFailure
                && refused.kind === 'refusal'
                && refused.code === 'EXECUTION_STEP_FAILED'
        } catch (error) {
            batchFailure = error instanceof Error ? error.message : 'runtime-batch-failed'
        } finally {
            for (const project of projects) {
                const result = await executeAdapter(project, 'down')
                if (!result || result.kind !== 'complete') cleanupFailures.push(`project:${sha256(project)}`)
            }
            for (const volume of [...ownedVolumes].sort()) {
                const step = dockerStep(`dependency-runtime:cleanup:${sha256(volume)}`, ['volume', 'rm', '-f', volume])
                if (!step || (await executeProbe(step)).kind !== 'complete') cleanupFailures.push(`volume:${sha256(volume)}`)
                const inspect = dockerStep(`dependency-runtime:cleanup-readback:${sha256(volume)}`, ['volume', 'inspect', volume])
                const outcome = inspect ? await executeProbe(inspect) : undefined
                if (!outcome || outcome.kind !== 'refusal' || outcome.code !== 'EXECUTION_STEP_FAILED'
                    || !outcome.execution.started || outcome.execution.exitCode === 0) cleanupFailures.push(`volume-readback:${sha256(volume)}`)
            }
            for (const project of projects) {
                for (const [resource, argv] of [
                    ['container', ['container', 'ls', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]],
                    ['network', ['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]],
                    ['volume', ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]],
                ] as const) {
                    const step = dockerStep(`dependency-runtime:cleanup-list:${resource}:${sha256(project)}`, argv)
                    const outcome = step ? await executeProbe(step) : undefined
                    if (!outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0
                        || outcome.stdout.toString('utf8').trim() !== '') cleanupFailures.push(`${resource}-readback:${sha256(project)}`)
                }
            }
            await rm(stateHome, { recursive: true, force: true })
        }

        const evidence = Object.freeze({
            version: 1,
            cell: 'native-dependency-runtime',
            kind: candidate && unmountedControl && incompatibleAbiControl && cleanupFailures.length === 0 ? 'passed' : 'unavailable',
            code: candidate && unmountedControl && incompatibleAbiControl && cleanupFailures.length === 0
                ? 'DEPENDENCY_RUNTIME_PAIRED_CONTROLS_PASSED'
                : 'DEPENDENCY_RUNTIME_PAIRED_CONTROLS_INCOMPLETE',
            configSha256: sourceSha256,
            generation,
            images: { glibcReferenceSha256: sha256(service.image.reference), muslReferenceSha256: sha256(muslImage) },
            generatedAdmission: true,
            candidate,
            unmountedControl,
            incompatibleAbiControl,
            batchFailure,
            cleanup: { survivors: cleanupFailures },
        })
        await persist(evidence)
        if (evidence.kind === 'passed') expect(evidence).toMatchObject({ generatedAdmission: true, candidate: true, unmountedControl: true, incompatibleAbiControl: true, cleanup: { survivors: [] } })
        else expect(evidence.kind).toBe('unavailable')
    })
})
