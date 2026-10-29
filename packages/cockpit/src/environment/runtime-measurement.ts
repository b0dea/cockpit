/**
 * Owns `cockpit runtime measure`: identifies the local container runtime, hands it to the
 * candidate and broken-control probe (`runtime-probe.ts`), and turns a passing verdict into one
 * `[[environment.runtime_measurements]]` row, printed or appended to cockpit.toml.
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
import { admitLocalDockerEndpoint } from './docker-endpoint.js'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { loadCockpitConfig } from '../config/load.js'
import { writeVerifiedConfig } from '../config/verified-write.js'
import type { Diagnostic } from '../diagnostics.js'
import { ENVIRONMENT_CODES, type ExecutionStep } from './contract.js'
import { declaresNothingToRun, runtimeNotDeclared } from './declaration.js'
import { resolveDockerExecutable, resolveGitExecutable, type ResolvedExecutable } from './executable.js'
import { admitRuntimeMeasurement, observeDockerRuntime, observedVersionCore } from './runtime.js'
import { probeRuntimeSupport, type RuntimeProbeRequest, type RuntimeProbeVerdict } from './runtime-probe.js'

export const mechanism = {
    id: 'runtime-measurement-recording',
    module: 'packages/cockpit/src/environment/runtime-measurement.ts',
    exports: ['runRuntimeMeasure', 'probeInstalledRuntime'],
} as const

export interface RuntimeMeasureInput {
    readonly configPath: string
    readonly image: string
    readonly write: boolean
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

function tomlRow(row: Readonly<Record<string, string>>): string {
    return ['[[environment.runtime_measurements]]', ...Object.entries(row).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), ''].join('\n')
}

function inlineRow(row: Readonly<Record<string, string>>): string {
    return `{ ${Object.entries(row).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }`
}

type MultilineDelimiter = '"""' | "'''"

function multilineEnd(line: string, delimiter: MultilineDelimiter, start: number): number {
    let candidate = line.indexOf(delimiter, start)
    while (candidate !== -1 && delimiter === '"""') {
        let escapes = 0
        for (let index = candidate - 1; index >= 0 && line[index] === '\\'; index -= 1) escapes += 1
        if (escapes % 2 === 0) break
        candidate = line.indexOf(delimiter, candidate + delimiter.length)
    }
    return candidate
}

/** Return only TOML syntax outside strings and comments, carrying multiline-string state between lines. */
function tomlCode(line: string, initial: MultilineDelimiter | null): Readonly<{ code: string; multiline: MultilineDelimiter | null }> {
    let code = ''
    let multiline = initial
    for (let index = 0; index < line.length;) {
        if (multiline !== null) {
            const end = multilineEnd(line, multiline, index)
            if (end === -1) return { code, multiline }
            index = end + multiline.length
            multiline = null
            continue
        }
        const triple = line.slice(index, index + 3)
        if (triple === '"""' || triple === "'''") {
            multiline = triple
            index += 3
            continue
        }
        const char = line[index]!
        if (char === '#') break
        if (char === '"' || char === "'") {
            const quote = char
            index += 1
            while (index < line.length) {
                if (quote === '"' && line[index] === '\\') index += 2
                else if (line[index] === quote) { index += 1; break }
                else index += 1
            }
            continue
        }
        code += char
        index += 1
    }
    return { code, multiline }
}

/** Replace only the generator's empty field in `[environment]`; unsupported TOML layouts fall through to verified refusal. */
function rowEdit(original: string, row: Readonly<Record<string, string>>): string {
    const lines = original.split('\n')
    let table = ''
    let multiline: MultilineDelimiter | null = null
    let target: number | null = null
    for (const [index, line] of lines.entries()) {
        const scanned = tomlCode(line, multiline)
        multiline = scanned.multiline
        if (multiline !== null || scanned.code.trim().length === 0) continue
        const header = /^\s*\[([^\[\]]+)]\s*$/.exec(scanned.code)
        if (header) table = header[1]!.trim()
        else if (table === 'environment' && /^\s*runtime_measurements\s*=\s*\[\]\s*$/.test(scanned.code)) {
            if (target !== null) return original
            target = index
        }
    }
    if (target !== null) {
        lines[target] = lines[target]!.replace(/\[\]/, `[ ${inlineRow(row)} ]`)
        return lines.join('\n')
    }
    return `${original}${original.length === 0 || original.endsWith('\n') ? '' : '\n'}\n${tomlRow(row)}`
}

function withoutLastMeasurement(config: unknown): string {
    const value = config as { environment: { runtime_measurements: readonly unknown[] } }
    return JSON.stringify({ ...value, environment: { ...value.environment,
        runtime_measurements: value.environment.runtime_measurements.slice(0, -1) } })
}

/** Accept a parsed configuration only when it is `base` plus exactly `row`, appended. */
function exactlyOneRowAdded(base: unknown, next: unknown, row: Readonly<Record<string, string>>): boolean {
    const measurements = (next as { environment?: { runtime_measurements?: readonly unknown[] } }).environment?.runtime_measurements
    const baseCount = (base as { environment: { runtime_measurements: readonly unknown[] } }).environment.runtime_measurements.length
    return Array.isArray(measurements) && measurements.length === baseCount + 1
        && JSON.stringify(measurements.at(-1)) === JSON.stringify(row)
        && withoutLastMeasurement(next) === JSON.stringify(base)
}

type AppendResult = Readonly<{ kind: 'complete' }> | Readonly<{ kind: 'refused'; outcome: RuntimeMeasureOutcome }>

async function appendRow(path: string, expectedSha256: string, baseConfig: unknown, row: Readonly<Record<string, string>>): Promise<AppendResult> {
    const written = await writeVerifiedConfig({
        path, expectedSha256, temporaryTag: 'measure',
        edit: (original) => rowEdit(original, row),
        isExactChange: (config) => exactlyOneRowAdded(baseConfig, config, row),
        messages: {
            changedBefore: 'cockpit.toml changed while the runtime was being measured; nothing was written. Re-run the measurement',
            changedDuring: 'cockpit.toml changed while the row was being prepared; nothing was written. Re-run the measurement',
            invalid: (reason) => `appending the row would leave cockpit.toml invalid (${reason}); nothing was written. `
                + `Add it to environment.runtime_measurements by hand: ${inlineRow(row)}`,
            notExact: `appending the row would change more than one measurement row; nothing was written. Add it by hand: ${inlineRow(row)}`,
            writtenMismatch: 'the row was written, but re-reading cockpit.toml shows a change other than that one row; inspect the file before running up',
        },
    })
    return written.kind === 'complete' ? written : { kind: 'refused', outcome: refused(written.code, written.message, path) }
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
    // The probe authenticates the context it runs against and refuses an override it cannot see.
    if (input.env.DOCKER_CONTEXT !== undefined) {
        return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            'DOCKER_CONTEXT overrides the selected Docker context; select it with `docker context use <name>` and unset DOCKER_CONTEXT', 'DOCKER_CONTEXT')
    }
    const path = input.env.PATH ?? ''
    const [docker, git] = await Promise.all([resolveDockerExecutable(input.env), resolveGitExecutable(input.env)])
    if (docker.state !== 'available') return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, docker.reason, 'docker')
    if (git.state !== 'available') return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, git.reason, 'git')
    const cwd = dirname(configPath)

    // Refuse a remote endpoint before minutes of probing. The endpoint is observed, never forced on the
    // probe: cockpit's owners hand Docker no HOME, so the CLI resolves the operator's selected context
    // itself, and down and reset select by context name. Pinning DOCKER_HOST here would leave them
    // resolving the "default" context instead.
    let dockerHost = input.env.DOCKER_HOST
    let endpointSource = 'DOCKER_HOST'
    if (dockerHost === undefined) {
        const contextEnv = Object.freeze({ PATH: path })
        const context = await readDocker(dependencies.execute, dockerStep(docker.value, cwd, contextEnv, 'runtime:measure:context', ['context', 'show']))
        const endpoint = context.kind === 'complete'
            ? await readDocker(dependencies.execute, dockerStep(docker.value, cwd, contextEnv, 'runtime:measure:endpoint',
                ['context', 'inspect', context.text, '--format', '{{.Endpoints.docker.Host}}']))
            : context
        if (endpoint.kind !== 'complete') {
            return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, `the selected Docker context endpoint could not be read (${endpoint.detail})`, 'docker context')
        }
        dockerHost = endpoint.text
        endpointSource = `docker context ${context.kind === 'complete' ? context.text : ''}`
    }
    if (admitLocalDockerEndpoint(dockerHost) === undefined) {
        return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            `the Docker endpoint from ${endpointSource} is not a local Docker endpoint; only a local runtime can be measured. Select a local context with docker context use <name> or set a local DOCKER_HOST`, endpointSource)
    }
    const runtimeEnv = Object.freeze({ PATH: path, ...(input.env.DOCKER_HOST === undefined ? {} : { DOCKER_HOST: input.env.DOCKER_HOST }) })

    const observed = await observeDockerRuntime({ executable: docker.value, cwd, env: runtimeEnv, timeoutMs: STEP_TIMEOUT_MS }, dependencies.execute)
    if (observed.kind !== 'complete') return refused(observed.code, observed.reason, 'docker')
    const identity = observed.runtimeIdentity
    if (identity === null) {
        const admission = admitRuntimeMeasurement(observed, config.environment.runtime_measurements)
        return refused(ENVIRONMENT_CODES.RUNTIME_UNMEASURED, admission.kind === 'unavailable' ? admission.reason : 'the runtime is not identified', 'docker info')
    }
    if (input.write && config.environment.runtime_measurements.some((row) => row.runtime === identity)) {
        return refused(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
            `cockpit.toml already has a runtime_measurements row for ${identity}; remove it before recording a new measurement with --write`, configPath)
    }

    const image = await readDocker(dependencies.execute, dockerStep(docker.value, cwd, runtimeEnv, 'runtime:measure:image',
        ['image', 'inspect', input.image, '--format', '{{.Id}}']))
    if (image.kind !== 'complete' || !IMAGE_ID.test(image.text)) {
        return refused(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            `--image ${JSON.stringify(input.image)} is not a local image (${image.kind === 'complete' ? 'unexpected image ID' : image.detail}); `
            + 'pull or build it first, the probe never pulls', '--image')
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
            executable: docker.value, gitExecutable: git.value, cwd: probeRoot,
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
        endpoint: Object.freeze({ value: dockerHost, source: endpointSource }),
        image: image.text, candidate: verdict.candidate, brokenControl: verdict.brokenControl,
        checks: evidence?.candidateChecks ?? null,
    })
    if (verdict.status !== 'supported' || verdict.candidate !== 'passed' || verdict.brokenControl !== 'rejected') {
        return Object.freeze({ ...refused(verdict.operatorAction?.code ?? ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            `runtime ${identity} was not measured as supported (candidate ${verdict.candidate}, broken control ${verdict.brokenControl}): `
            + `${verdict.operatorAction?.reason ?? 'no reason was reported'}; nothing was written`, identity), result: summary })
    }
    // The probe observes the runtime again; a different daemon or Compose answering it would make
    // this row describe something other than the identity read above.
    if (evidence === null || evidence.runtimeVersion !== observed.runtime.version || evidence.composeVersion !== observed.composeVersion
        || evidence.runtimeExecutableSha256 !== docker.value.sha256) {
        return Object.freeze({ ...refused(ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
            `the probe measured a different runtime than ${identity} ${observed.runtime.version} with Compose ${observed.composeVersion}; nothing was written`, identity), result: summary })
    }

    const row = Object.freeze({ runtime: identity, compose_floor: composeFloor, measured_on: measuredOn,
        candidate: 'passed', broken_control: 'rejected', status: 'supported' })
    const toml = tomlRow(row)
    // The printed row stays valid TOML to paste, so what happened to it travels as a comment.
    const printed = (note: string) => `# ${note}\n${toml}`
    if (!input.write) {
        return Object.freeze({ status: 0, result: Object.freeze({ ...summary, row, toml, written: false }), destination: null,
            artifact: printed(`runtime ${identity} passed; re-run with --write to append this row to ${configPath}`), diagnostics: Object.freeze([]) })
    }
    const appended = await appendRow(configPath, loaded.result.source.sha256, config, row)
    if (appended.kind === 'refused') return Object.freeze({ ...appended.outcome, result: Object.freeze({ ...summary, row, toml, written: false }) })
    return Object.freeze({ status: 0, result: Object.freeze({ ...summary, row, toml, written: true }), destination: null,
        artifact: printed(`runtime ${identity} passed; appended this row to ${configPath}`), diagnostics: Object.freeze([]) })
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
