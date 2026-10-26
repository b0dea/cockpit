import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { ENVIRONMENT_CODES, type StackId } from './contract.js'
import { resolvedExecutable, resolveGitExecutable } from './executable.js'
import { observeHostCapacity } from './host-observation.js'
import { collectMachineFloorEvidence, createMachineFloorPlan, issueMachineFloorAuthority, type MachineFloorEvidence } from './runtime.js'
import { loadCockpitConfig, projectMachineFloorConfig } from '../config/load.js'
import { observeSetupCheckout, withSetupCheckoutProjection } from './setup-observation.js'
import { evaluatePreflight, resolveObservationPostures } from './observations.js'
import { resolveLifecycleStage } from './lifecycle-stage.js'
import { observeConfiguration, selectStateRoot } from './state.js'
import { checkoutId as deriveCheckoutId, cockpitId as deriveCockpitId, stackId as deriveStackId } from './identity.js'

const authorityRoot = join(realpathSync(tmpdir()), `cockpit-host-authority-${process.pid}`)
const authorityCheckout = join(authorityRoot, 'checkout')
const authorityCockpitId = deriveCockpitId({ name: 'fixture', mainCheckoutPath: authorityCheckout })
const stackId = deriveStackId({ cockpitId: authorityCockpitId, checkoutId: deriveCheckoutId({ checkoutPath: authorityCheckout }), variant: { kind: 'shared' } })
const run = promisify(execFile)

afterEach(async () => rm(authorityRoot, { recursive: true, force: true }))

async function evaluationContext(evaluatedAt: string) {
    const root = authorityCheckout
    await mkdir(root, { recursive: true })
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, `[cockpit]\nname = "fixture"\n\n[[sibling]]\nslug = "service"\ndir = "service"\nremote = "https://example.invalid/service.git"\nmount = "always"\nacquire = "manual"\nvar = "SERVICE_DIR"\npurpose = "synthetic service"\n\n[ports.bases]\nWEB = 3000\n\n[environment]\naddressing = "hostname"\nauthentication = "real"\nposture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "real" }]\n`)
    const configuration = (await observeConfiguration({ stackId, observedAt: evaluatedAt, path: configPath }))
        .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
    const posture = await resolveObservationPostures({
        configuration, cockpitId: authorityCockpitId, checkoutPath: authorityCheckout, variant: { kind: 'shared' },
    })
    const state = await selectStateRoot({ platform: 'linux', home: root, cockpitId: authorityCockpitId })
    if (state.kind !== 'complete') throw new Error('fixture state root was refused')
    const stage = await resolveLifecycleStage({ namespace: state.value, stackId, observedAt: evaluatedAt })
    if (stage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
    return { authorities: [posture], stages: [stage.authority] }
}

async function evidence(memoryBytes: number, cpus: number, freeBlocks: number, floor = { memoryBytes, cpuMillis: cpus * 1_000, freeDiskBytes: freeBlocks * 1_024 }, runtimeEnv: Readonly<Record<string, string>> = {}): Promise<MachineFloorEvidence> {
    const root = authorityCheckout
    await mkdir(root, { recursive: true })
    const dockerPath = join(root, 'docker')
    const diskPath = join(root, 'df')
    const dockerBody = `#!/bin/sh\nprintf '${memoryBytes}|${cpus}\\n'\n`
    const diskBody = `#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted-on\\nfixture 100 1 ${freeBlocks} 1%% /\\n'\n`
    await writeFile(dockerPath, dockerBody); await writeFile(diskPath, diskBody)
    await chmod(dockerPath, 0o755); await chmod(diskPath, 0o755)
    const executable = (path: string, body: string) => resolvedExecutable({
        canonicalPath: path, invocationPath: path,
        sha256: createHash('sha256').update(body).digest('hex'), executionMode: 'staged',
    })!
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, `[cockpit]\nname = "fixture"\nsiblings_root = "siblings"\n\n[[sibling]]\nslug = "data"\ndir = "data"\nmount = "none"\nacquire = "none"\nvar = "DATA_DIR"\ntoolchain = "none"\npurpose = "Synthetic data"\n\n[ports]\nstep = 10\ncount = 2\nbases = { WEB = 3000 }\n\n[environment.machine]\nruntime_memory_mb = ${floor.memoryBytes / 1_048_576}\nruntime_cpus = ${floor.cpuMillis / 1_000}\nfree_disk_mb = ${floor.freeDiskBytes / 1_048_576}\ncold_start_seconds = 30\n`)
    await run('git', ['init', '--quiet', root])
    await mkdir(join(root, 'siblings', 'data'), { recursive: true })
    const loaded = await loadCockpitConfig(configPath)
    const git = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
    if (loaded.kind !== 'complete' || git.state !== 'available') throw new Error(`fixture authority source was refused: ${JSON.stringify({ loaded, git })}`)
    const observedAt = new Date().toISOString()
    const checkout = await observeSetupCheckout({
        source: loaded.result.source, cockpitName: 'fixture', observedAt,
        env: { PATH: process.env.PATH ?? '' }, gitExecutable: git.value,
    })
    const machine = projectMachineFloorConfig(loaded.result)
    const binding = machine ? await withSetupCheckoutProjection(checkout, {
        source: loaded.result.source, cockpitName: 'fixture', evaluatedAt: Date.parse(observedAt),
    }, (projection) => issueMachineFloorAuthority({ configuration: machine, checkout: projection })) : undefined
    if (!binding) throw new Error('fixture authority was refused')
    const planned = createMachineFloorPlan({
        runtimeExecutable: executable(dockerPath, dockerBody), diskExecutable: executable(diskPath, diskBody),
        cwd: root, env: runtimeEnv, timeoutMs: 10_000, authority: binding.authority,
    })
    if (planned.kind !== 'preview') throw new Error('fixture plan was refused')
    const outcomes = await Promise.all(planned.plan.steps.map((step) => executeProbe(step)))
    expect(collectMachineFloorEvidence({ ...planned.plan }, outcomes as [typeof outcomes[0], typeof outcomes[1]])).toBeUndefined()
    const result = collectMachineFloorEvidence(planned.plan, outcomes as [typeof outcomes[0], typeof outcomes[1]])
    if (!result) throw new Error(`fixture evidence was rejected: ${JSON.stringify(outcomes)}`)
    return result
}

describe('host capacity evidence', () => {
    it('refuses loader injection inherited from a runtime plan', async () => {
        await expect(evidence(1_048_576, 1, 1_024, undefined, { LD_PRELOAD: '/tmp/untrusted.so' })).rejects.toThrow('fixture plan was refused')
    })
    it('rejects raw caller measurements without a digest-bound machine-floor result', () => {
        expect(() => observeHostCapacity({
            stackId,
            floor: { memoryBytes: 1, cpuMillis: 1, freeDiskBytes: 1 },
            evidence: { memoryBytes: 1, cpuMillis: 1, freeDiskBytes: 1 },
        } as never)).toThrow('machine-floor evidence is not authentic')
    })

    it('does not invoke a hostile getter and fails closed', () => {
        let reads = 0
        const input = Object.defineProperty({}, 'stackId', {
            enumerable: true,
            get() { reads += 1; throw new Error('revoked') },
        })
        expect(() => observeHostCapacity(input as never)).toThrow('machine-floor evidence is not authentic')
        expect(reads).toBe(0)
    })

    it('uses only authenticated exact machine-floor evidence', async () => {
        const exact = await evidence(8_589_934_592, 2, 10_240)
        const floor = { memoryBytes: exact.memoryBytes, cpuMillis: exact.cpuMillis, freeDiskBytes: exact.freeDiskBytes }
        const observations = observeHostCapacity({ evidence: exact })
        expect(evaluatePreflight(observations, await evaluationContext(exact.observedAt)).checks
            .filter(({ owner }) => owner === 'host-observation').every(({ verdict }) => verdict === 'pass')).toBe(true)
        const raised = { memoryBytes: floor.memoryBytes + 1_048_576, cpuMillis: floor.cpuMillis + 1_000, freeDiskBytes: floor.freeDiskBytes + 1_048_576 }
        const below = await evidence(8_589_934_592, 2, 10_240, raised)
        expect(evaluatePreflight(observeHostCapacity({ evidence: below }), {
            ...await evaluationContext(below.observedAt), declarations: [],
        }).verdict).toBe('fail')
        expect(observations.map(({ observed }) => observed)).toEqual(expect.arrayContaining([
            { state: 'available', value: 8_589_934_592, observedAt: exact.observedAt },
            { state: 'available', value: 2_000, observedAt: exact.observedAt },
            { state: 'available', value: 10_485_760, observedAt: exact.observedAt },
        ]))
    })
})
