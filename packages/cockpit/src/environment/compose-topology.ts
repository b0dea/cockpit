// Reads the service topology of a cockpit's own Compose files, as Compose itself resolves them, and
// judges it against what parallel stacks need. It owns one bounded `docker compose config` probe
// (dispatched through environment-exec/execute.ts) and the projection of its JSON; it never parses
// the YAML itself, never interpolates the environment, and never starts anything. The generated
// environment does not come through here: its topology is the one cockpit rendered.
//
// The runtime topology admitted by runtime.ts serves `up` and keeps only what readiness needs; it
// drops published ports and image references, which are exactly what these detectors judge.
import { resolve } from 'node:path'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { readAnchoredBatches } from '../generated-environment/transaction.js'
import { snapshotExecutionStep, type Diagnostic, type ExecutionStep } from './contract.js'
import type { ResolvedExecutable } from './executable.js'
import { redactSensitiveText } from './sensitive.js'

export const mechanism = {
    id: 'compose-topology',
    module: 'packages/cockpit/src/environment/compose-topology.ts',
    exports: ['observeComposeTopology', 'assessComposeTopology'],
} as const

export interface ComposeTopologyInput {
    /** Canonical absolute project directory; relative paths in the Compose files resolve against it. */
    readonly root: string
    /** The declared `environment.compose_files`, relative to `root`. */
    readonly references: readonly string[]
    readonly projectName: string
    readonly docker: ResolvedExecutable
    /** Reads the declared files through the anchored reader, so the probe consumes authenticated bytes. */
    readonly node: ResolvedExecutable
    /** Filtered to the Docker connection variables before it reaches the probe. */
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface ComposePublishedPort {
    /** The host side exactly as written, `null` when Compose picks an ephemeral host port. */
    readonly published: string | null
    readonly target: string
}

export interface ComposeServiceTopology {
    readonly id: string
    readonly ports: readonly ComposePublishedPort[]
    readonly healthcheck: boolean
    readonly image: string | null
    readonly build: boolean
}

export type ComposeTopologyObservation =
    | Readonly<{ kind: 'complete'; services: readonly ComposeServiceTopology[] }>
    | Readonly<{ kind: 'unavailable'; reason: string }>

// The same allowlist the lifecycle owners hand Docker: no HOME, so no per-user configuration or
// credential helper can change what Compose resolves.
const DOCKER_ENVIRONMENT = new Set(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
const OUTPUT_LIMIT_BYTES = 1_048_576
const STDERR_LIMIT_BYTES = 65_536
const SERVICE_LIMIT = 4_096
const TIMEOUT_MS = 30_000
const SERVICE_ID = /^[a-z0-9][a-z0-9_.-]*$/
const PINNED_IMAGE = /@sha256:[a-f0-9]{64}$/

function unavailable(reason: string): ComposeTopologyObservation {
    return Object.freeze({ kind: 'unavailable', reason })
}

type ComposeFiles = readonly Readonly<{ path: string; sha256: string }>[]

function topologyStep(input: ComposeTopologyInput, composeFiles: ComposeFiles): ExecutionStep | undefined {
    const fileArgs = composeFiles.flatMap(({ path }) => ['--file', path])
    return snapshotExecutionStep({
        id: `compose-topology:${input.projectName}`,
        argv: [input.docker.canonicalPath, 'compose', '--project-directory', input.root, ...fileArgs,
            '--project-name', input.projectName, 'config', '--format', 'json', '--no-interpolate', '--no-env-resolution'],
        argv0: input.docker.invocationPath,
        cwd: input.root,
        env: Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => DOCKER_ENVIRONMENT.has(entry[0]) && typeof entry[1] === 'string')),
        timeoutMs: TIMEOUT_MS,
        stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
        stderrLimitBytes: STDERR_LIMIT_BYTES,
        paths: composeFiles.map(({ path }) => path),
        ports: [],
        labels: { operation: 'compose-topology' },
        expected: [],
        consumedFiles: [
            { path: input.docker.canonicalPath, sha256: input.docker.sha256, maxBytes: 536_870_912,
                argvIndexes: [0], executable: true, executionMode: input.docker.executionMode },
            ...composeFiles.map(({ path, sha256 }, index) => ({
                path, sha256, maxBytes: OUTPUT_LIMIT_BYTES, argvIndexes: [5 + index * 2], executable: false as const,
            })),
        ],
        filesystemChecks: [],
        compensation: [],
    })
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

// Compose keeps a port it could not interpolate in its short `[ip:]host:container[/proto]` form,
// and normalises literal ports to the long form. Both are read here; variable references and
// bracketed IPv6 addresses are kept whole so their colons do not split the mapping.
function shortPort(value: string): ComposePublishedPort | undefined {
    const segments: string[] = []
    let current = ''
    let depth = 0
    let bracket = false
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]!
        if (character === '$' && value[index + 1] === '{') depth += 1
        else if (character === '}' && depth > 0) depth -= 1
        else if (character === '[' && depth === 0) bracket = true
        else if (character === ']' && depth === 0) bracket = false
        if (character === ':' && depth === 0 && !bracket) {
            segments.push(current)
            current = ''
        } else current += character
    }
    segments.push(current.replace(/\/(?:tcp|udp|sctp)$/, ''))
    if (depth !== 0 || bracket || segments.length > 3 || segments.some((segment, index) => segment === '' && index === segments.length - 1)) return undefined
    if (segments.length === 1) return Object.freeze({ published: null, target: segments[0]! })
    const published = segments[segments.length - 2]!
    return Object.freeze({ published: published === '' ? null : published, target: segments[segments.length - 1]! })
}

function longPort(value: Record<string, unknown>): ComposePublishedPort | undefined {
    const target = value.target
    const published = value.published
    if (typeof target !== 'number' && typeof target !== 'string') return undefined
    if (published === undefined || published === null || published === '') return Object.freeze({ published: null, target: String(target) })
    if (typeof published !== 'number' && typeof published !== 'string') return undefined
    return Object.freeze({ published: String(published), target: String(target) })
}

function projectServices(stdout: Buffer): readonly ComposeServiceTopology[] | undefined {
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)) } catch { return undefined }
    const services = record(record(parsed)?.services)
    if (!services) return undefined
    const names = Object.keys(services).sort()
    if (names.length > SERVICE_LIMIT || names.some(name => !SERVICE_ID.test(name))) return undefined
    const projected: ComposeServiceTopology[] = []
    for (const id of names) {
        const service = record(services[id])
        if (!service) return undefined
        const rawPorts = service.ports ?? []
        if (!Array.isArray(rawPorts)) return undefined
        const ports = rawPorts.map(port => typeof port === 'string' ? shortPort(port) : record(port) ? longPort(record(port)!) : undefined)
        if (ports.some(port => port === undefined)) return undefined
        const health = service.healthcheck === undefined ? undefined : record(service.healthcheck)
        if (service.healthcheck !== undefined && !health) return undefined
        const test = health?.test
        const healthcheck = health !== undefined && health.disable !== true
            && !(Array.isArray(test) && test[0] === 'NONE')
        const image = service.image
        if (image !== undefined && typeof image !== 'string') return undefined
        projected.push(Object.freeze({
            id, ports: Object.freeze(ports as ComposePublishedPort[]), healthcheck,
            image: image ?? null, build: service.build !== undefined,
        }))
    }
    return Object.freeze(projected)
}

/** Runs Compose's own resolution of the declared files and projects the services it reports. */
export async function observeComposeTopology(
    input: ComposeTopologyInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<ComposeTopologyObservation> {
    if (input.references.length === 0) return unavailable('no Compose file is declared')
    const reads = await readAnchoredBatches(input.root, input.references.map(path => Object.freeze({
        path, maxBytes: OUTPUT_LIMIT_BYTES, action: 'read-file' as const,
    })), input.node, { execute })
    const composeFiles = reads?.kind === 'complete' && reads.results.length === input.references.length
        ? reads.results.map((read, index) => read.kind === 'complete'
            ? Object.freeze({ path: resolve(input.root, input.references[index]!), sha256: read.sha256 }) : undefined)
        : undefined
    if (!composeFiles || composeFiles.some(file => file === undefined)) {
        return unavailable(`a declared Compose file (${input.references.join(', ')}) is missing, larger than 1 MiB, or crosses a symbolic link`)
    }
    const step = topologyStep(input, composeFiles as ComposeFiles)
    if (!step) return unavailable('the Compose topology probe could not be bounded')
    const outcome = authenticatedExecutionOutcome(await execute(step), step)
    if (!outcome) return unavailable('the Compose topology probe returned unauthenticated evidence')
    if (outcome.kind !== 'complete') {
        const detail = redactSensitiveText(new TextDecoder().decode(outcome.stderr).trim().slice(0, 512))
        return unavailable(`docker compose config failed (${outcome.code})${detail ? `: ${detail}` : ''}`)
    }
    const services = projectServices(outcome.stdout)
    return services ? Object.freeze({ kind: 'complete', services }) : unavailable('docker compose config returned a topology this probe cannot read')
}

function variableName(value: string): string | undefined {
    return /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:]?[-?+][^}]*)?\}$/.exec(value)?.[1] ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)?.[1]
}

function suggestedVariable(service: string): string {
    return `${service.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_HOST_PORT`
}

/**
 * Judges a cockpit's own Compose topology. A host port that is not drawn from a leased
 * `ports.bases` variable is the same number in every worktree and parallel stack, so the second
 * stack to start fails to bind it; the remaining findings are warnings about what cockpit can
 * then promise, not about whether the stack runs.
 */
export function assessComposeTopology(
    services: readonly ComposeServiceTopology[],
    portVariables: readonly string[],
): readonly Diagnostic[] {
    const leased = new Set(portVariables)
    const diagnostics: Diagnostic[] = []
    for (const service of services) {
        for (const port of service.ports) {
            if (port.published === null) continue
            const variable = variableName(port.published)
            if (variable !== undefined && leased.has(variable)) continue
            const name = variable ?? suggestedVariable(service.id)
            diagnostics.push(Object.freeze({
                severity: 'error' as const, code: 'COMPOSE_PORT_NOT_LEASED', target: `compose:${service.id}:${port.target}`,
                message: `service ${service.id} publishes host port ${JSON.stringify(port.published)} for container port ${port.target}, which is not taken from a ports.bases variable; the same host port collides across worktrees and parallel stacks`,
                fix: `publish it as "\${${name}}:${port.target}" in the Compose file and declare ${name} under [ports.bases]`,
            }))
        }
        if (!service.healthcheck) diagnostics.push(Object.freeze({
            severity: 'warning' as const, code: 'COMPOSE_HEALTHCHECK_MISSING', target: `compose:${service.id}`,
            message: `service ${service.id} declares no Compose healthcheck, so running is treated as ready`,
            fix: `add a healthcheck to service ${service.id} that succeeds only once it serves requests`,
        }))
        if (!service.build && service.image !== null && !PINNED_IMAGE.test(service.image)) diagnostics.push(Object.freeze({
            severity: 'warning' as const, code: 'COMPOSE_IMAGE_UNPINNED', target: `compose:${service.id}`,
            message: `service ${service.id} runs image ${JSON.stringify(service.image)} by tag, so a later pull can change what runs`,
            fix: `pin it by digest, for example ${service.image.replace(/:[^/:]*$/, '')}@sha256:<digest> from docker image inspect`,
        }))
    }
    return Object.freeze(diagnostics)
}
