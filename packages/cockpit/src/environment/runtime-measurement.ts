/**
 * Owns `cockpit runtime measure`: identifies the local container runtime, hands it to the
 * candidate and broken-control probe (`runtime-probe.ts`), and records a passing verdict as this
 * machine's measurement through `runtime-measurement-record.ts`. cockpit.toml is only read: a
 * measurement describes this machine, so recording one changes no guarded configuration.
 *
 * It does not admit runtimes (`runtime.ts` reads the rows) and it never spawns a process itself:
 * every child process crosses the supplied `execute`, which production binds to
 * `environment-exec/execute.ts`.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectLocalDockerDaemon } from './docker-daemon.js'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { loadCockpitConfig } from '../config/load.js'
import type { Diagnostic } from '../diagnostics.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { ENVIRONMENT_CODES, type ExecutionStep } from './contract.js'
import { declaresNothingToRun, runtimeNotDeclared } from './declaration.js'
import { resolveDockerExecutable, resolveGitExecutable, type ResolvedExecutable } from './executable.js'
import { observeDockerRuntime, observedVersionCore } from './runtime.js'
import { recordLocalRuntimeMeasurement } from './runtime-measurement-record.js'
import { probeRuntimeSupport, type RuntimeProbeRequest, type RuntimeProbeVerdict } from './runtime-probe.js'

export const mechanism = {
    id: 'runtime-measurement-recording',
    module: 'packages/cockpit/src/environment/runtime-measurement.ts',
    exports: ['runRuntimeMeasure', 'probeInstalledRuntime'],
} as const

export interface RuntimeMeasureInput {
    readonly configPath: string
    readonly image: string
    readonly env: Readonly<Record<string, string | undefined>>
}

export type RuntimeMeasureProbe = (request: Omit<RuntimeProbeRequest, 'installedModule'>) => Promise<RuntimeProbeVerdict>

export interface RuntimeMeasureDependencies {
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    readonly probe: RuntimeMeasureProbe
}

export interface RuntimeMeasureOutcome {
    readonly status: number
    readonly result: unknown
    readonly diagnostics: readonly Diagnostic[]
    readonly artifact?: string | null
    readonly destination?: string | null
}

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/
const STEP_TIMEOUT_MS = 10_000
const PROBE_STEP_TIMEOUT_MS = 30_000

function refused(code: string, message: string, target?: string): RuntimeMeasureOutcome {
    return Object.freeze({ status: 2, result: null, artifact: null, destination: null,
        diagnostics: Object.freeze([Object.freeze({ severity: 'error' as const, code, message, ...(target === undefined ? {} : { target }) })]) })
}

function dockerStep(executable: ResolvedExecutable, cwd: string, env: Readonly<Record<string, string>>, id: string, args: readonly string[]): ExecutionStep {
    return Object.freeze({
        id,
        argv: Object.freeze([executable.canonicalPath, ...args]) as readonly [string, ...string[]],
        argv0: executable.invocationPath,
        cwd, env, timeoutMs: STEP_TIMEOUT_MS,
        stdoutLimitBytes: 1_024, stderrLimitBytes: 4_096,
        paths: Object.freeze([]), ports: Object.freeze([]),
        labels: Object.freeze({ purpose: id }),
        expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({
            path: executable.canonicalPath, sha256: executable.sha256,
            maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true as const,
            executionMode: executable.executionMode,
        })]),
        filesystemChecks: Object.freeze([]),
        compensation: Object.freeze([]),
    })
}

async function readDocker(execute: RuntimeMeasureDependencies['execute'], step: ExecutionStep): Promise<
    Readonly<{ kind: 'complete'; text: string }> | Readonly<{ kind: 'failed'; detail: string }>> {
    const outcome = authenticatedExecutionOutcome(await execute(step), step)
    if (!outcome) return { kind: 'failed', detail: 'the execution outcome could not be authenticated' }
    let stdout = ''
    let stderr = ''
    try {
        // Docker's final line ending is transport framing; trimming would rewrite endpoint identity.
        stdout = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout).replace(/\r?\n$/, '')
        stderr = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stderr).trim()
    } catch { return { kind: 'failed', detail: 'docker wrote output that is not UTF-8' } }
    if (outcome.kind !== 'complete') {
        return { kind: 'failed', detail: `${outcome.code}${stderr ? `: ${stderr.split('\n', 1)[0]!.slice(0, 256)}` : ''}` }
    }
    return { kind: 'complete', text: stdout }
}

export async function runRuntimeMeasure(input: RuntimeMeasureInput, dependencies: RuntimeMeasureDependencies): Promise<RuntimeMeasureOutcome> {
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return Object.freeze({ status: 2, result: null, diagnostics: loaded.diagnostics })
    const configPath = loaded.result.source.path
    const config = loaded.result.config
    if (declaresNothingToRun(config.environment)) return Object.freeze({ status: 2, result: null,
        diagnostics: Object.freeze([runtimeNotDeclared(configPath)]) })
    if (input.image.length === 0 || input.image.length > 256 || input.image.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(input.image)) {
        return refused('CLI_USAGE_INVALID', '--image must name one local image reference or ID', '--image')
    }
    // Refuse a remote daemon before minutes of probing, and measure exactly the daemon `up` will
    // reach: a local DOCKER_HOST as given, otherwise the context DOCKER_CONTEXT names or the active
    // one, pinned by name for every later step so a `docker context use` mid-run cannot move the
    // measurement to another daemon. cockpit's owners hand Docker no HOME, so a pinned name
    // resolves through the operator's own context store, as it does for `up`. The context is pinned
    // by name, not as its endpoint in DOCKER_HOST: that would leave down and reset inside the probe
    // resolving the "default" context instead.
    const daemon = await selectLocalDockerDaemon(input.env, STEP_TIMEOUT_MS, dependencies.execute, {
        command: 'runtime measure', localOnly: 'a measurement describes this machine, which a remote daemon says nothing about' })
    if (daemon.kind === 'refusal') return Object.freeze({ status: 2, result: null, artifact: null, destination: null, diagnostics: Object.freeze([daemon.diagnostic]) })
    const path = input.env.PATH ?? ''
    const [docker, git] = await Promise.all([resolveDockerExecutable(input.env), resolveGitExecutable(input.env)])
    if (docker.state !== 'available') return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, docker.reason, 'docker')
    if (git.state !== 'available') return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, git.reason, 'git')
    const cwd = dirname(configPath)
    const runtimeEnv = Object.freeze({ PATH: path,
        ...(input.env.DOCKER_HOST === undefined ? { DOCKER_CONTEXT: daemon.dockerContext } : { DOCKER_HOST: input.env.DOCKER_HOST }) })

    const observed = await observeDockerRuntime({ executable: docker.value, cwd, env: runtimeEnv, timeoutMs: STEP_TIMEOUT_MS }, dependencies.execute)
    if (observed.kind !== 'complete') return refused(observed.code, observed.reason, 'docker')
    const identity = observed.runtimeIdentity
    if (identity === null) {
        return refused(ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
            `Docker runtime is not a recognised product, so no measurement can apply (docker info: OperatingSystem ${JSON.stringify(observed.operatingSystem)}, `
            + `Name ${JSON.stringify(observed.name)}, OSType ${JSON.stringify(observed.osType)}; host ${observed.hostPlatform}). `
            + 'Report these docker info values to the cockpit maintainers so the runtime can be identified', 'docker info')
    }

    const image = await readDocker(dependencies.execute, dockerStep(docker.value, cwd, runtimeEnv, 'runtime:measure:image',
        ['image', 'inspect', input.image, '--format', '{{.Id}}']))
    if (image.kind !== 'complete' || !IMAGE_ID.test(image.text)) {
        // The runtime answered, so the remedy is the image, not the runtime.
        return Object.freeze({ status: 2, result: null, artifact: null, destination: null, diagnostics: Object.freeze([Object.freeze({
            severity: 'error' as const,
            code: 'RUNTIME_IMAGE_UNAVAILABLE' satisfies typeof ENVIRONMENT_CODES.RUNTIME_IMAGE_UNAVAILABLE,
            message: `--image ${JSON.stringify(input.image)} is not a local image (${image.kind === 'complete' ? 'unexpected image ID' : image.detail}); the probe never pulls`,
            target: '--image',
            fix: 'pull or build it first (docker pull <image>), then run npx --no cockpit runtime measure --config <your cockpit.toml> --image <image> again',
        })]) })
    }

    // The floor is the numeric core; a vendor suffix such as `-desktop.1` is evidence, not a floor.
    const composeFloor = observedVersionCore(observed.composeVersion)
    if (composeFloor === undefined) return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
        `Docker Compose reported version ${JSON.stringify(observed.composeVersion.slice(0, 64))}, which has no numeric X.Y.Z core`, 'docker compose version')
    const measuredOn = new Date().toISOString().slice(0, 10)
    // The probe requires an empty canonical directory and creates its isolated HOME beside it, so
    // both live under one private parent that is removed whatever the verdict.
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-runtime-measure-')))
    let verdict: RuntimeProbeVerdict
    try {
        const probeRoot = join(parent, 'probe')
        await mkdir(probeRoot, { mode: 0o700 })
        verdict = await dependencies.probe({
            executable: docker.value, gitExecutable: git.value, cwd: probeRoot, projectPrefix: config.cockpit.name.slice(0, 40),
            env: Object.freeze({ ...runtimeEnv, ...(input.env.TMPDIR === undefined ? {} : { TMPDIR: input.env.TMPDIR }) }),
            composeFloor, measuredOn, timeoutMs: PROBE_STEP_TIMEOUT_MS,
            image: Object.freeze({ reference: image.text, id: image.text }),
        })
    } finally {
        await rm(parent, { recursive: true, force: true })
    }

    const evidence = verdict.evidence
    const summary = Object.freeze({
        runtime: identity, dockerInfo: Object.freeze({ operatingSystem: observed.operatingSystem, name: observed.name, osType: observed.osType }),
        endpoint: Object.freeze({ value: daemon.endpoint, source: daemon.source }),
        image: image.text, candidate: verdict.candidate, brokenControl: verdict.brokenControl,
        checks: evidence?.candidateChecks ?? null,
    })
    if (verdict.status !== 'supported' || verdict.candidate !== 'passed' || verdict.brokenControl !== 'rejected') {
        return Object.freeze({ ...refused(verdict.operatorAction?.code ?? ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            `runtime ${identity} was not measured as supported (candidate ${verdict.candidate}, broken control ${verdict.brokenControl}): `
            + `${verdict.operatorAction?.reason ?? 'no reason was reported'}; nothing was recorded`, identity), result: summary })
    }
    // The probe observes the runtime again; a different daemon or Compose answering it would make
    // this row describe something other than the identity read above.
    if (evidence === null || evidence.runtimeVersion !== observed.runtime.version || evidence.composeVersion !== observed.composeVersion
        || evidence.runtimeExecutableSha256 !== docker.value.sha256) {
        return Object.freeze({ ...refused(ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
            `the probe measured a different runtime than ${identity} ${observed.runtime.version} with Compose ${observed.composeVersion}; nothing was recorded`, identity), result: summary })
    }

    const row = Object.freeze({ runtime: identity, daemon: observed.name, engineVersion: observed.runtime.version,
        composeFloor, measuredOn })
    const recorded = await recordLocalRuntimeMeasurement(cwd, row)
    if (recorded.kind === 'refusal') {
        return Object.freeze({ ...refused(ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
            `runtime ${identity} passed, but this machine's measurement could not be recorded in ${recorded.path}: ${recorded.reason}`, recorded.path),
            result: Object.freeze({ ...summary, row, recorded: false }) })
    }
    const notes = [
        `runtime ${identity} on daemon ${JSON.stringify(observed.name)} passed with engine ${row.engineVersion}; recorded with Compose floor ${composeFloor} in ${recorded.path}`,
        ...(recorded.replaced === null ? [] : [`it replaces the measurement from ${recorded.replaced.measuredOn} (engine ${recorded.replaced.engineVersion})`]),
        ...(recorded.discardedUnreadable === null ? [] : [`the previous record was unreadable and was replaced: ${recorded.discardedUnreadable}`]),
        `cockpit.toml is unchanged; next: ${cockpitCommand('up', { config: configPath })}`,
    ]
    return Object.freeze({ status: 0, result: Object.freeze({ ...summary, row, recorded: true, path: recorded.path }), destination: null,
        artifact: `${notes.join('\n')}\n`, diagnostics: Object.freeze([]) })
}

/**
 * Production probe binding. The probe only certifies itself when it runs from an installed package,
 * so a source checkout is told that directly instead of failing deep inside the probe.
 */
export async function probeInstalledRuntime(request: Omit<RuntimeProbeRequest, 'installedModule'>): Promise<RuntimeProbeVerdict> {
    const modulePath = fileURLToPath(new URL('./runtime-probe.js', import.meta.url))
    const canonicalPath = await realpath(modulePath)
    const installedSuffix = ['node_modules', '@b0dea', 'cockpit', 'dist', 'environment', 'runtime-probe.js'].join(sep)
    if (!canonicalPath.endsWith(`${sep}${installedSuffix}`)) {
        return Object.freeze({
            status: 'unavailable', runtime: null, composeVersion: null, composeFloor: request.composeFloor, measuredOn: request.measuredOn,
            candidate: 'failed', brokenControl: 'inconclusive', evidence: null,
            operatorAction: Object.freeze({ required: true, code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
                reason: `runtime measurement runs only from an installed @b0dea/cockpit package, and this cockpit runs from ${dirname(canonicalPath)}; install the package and use its cockpit binary` }),
        })
    }
    const sha256 = createHash('sha256').update(await readFile(canonicalPath)).digest('hex')
    return probeRuntimeSupport({ ...request, installedModule: Object.freeze({ canonicalPath, sha256 }) })
}
