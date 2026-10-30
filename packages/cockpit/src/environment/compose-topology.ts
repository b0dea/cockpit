// Reads the service topology of a cockpit's own Compose files, as Compose itself resolves them, and
// judges it against what parallel stacks need. It owns one bounded `docker compose config` probe
// (dispatched through environment-exec/execute.ts) and the projection of its JSON; it never parses
// the YAML itself, never interpolates the environment, and never starts anything. The generated
// environment does not come through here: its topology is the one cockpit rendered.
//
// The runtime topology admitted by runtime.ts serves `up` and keeps only what readiness needs; it
// drops published ports and image references, which are exactly what these detectors judge.
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { readAnchoredBatches } from '../generated-environment/transaction.js'
import { snapshotExecutionStep, type Diagnostic, type ExecutionStep } from './contract.js'
import type { ResolvedExecutable } from './executable.js'
import { redactSensitiveText } from './sensitive.js'
import { cockpitCommand } from '../fix-catalogue.js'

export const mechanism = {
    id: 'compose-topology',
    module: 'packages/cockpit/src/environment/compose-topology.ts',
    exports: ['observeComposeTopology', 'assessComposeTopology', 'composeBindPath', 'compareBindSources', 'redirectedBindSources'],
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
    /**
     * Each volume source as Compose reports it without interpolation: the absolute host path of a
     * bind, or the raw `${VAR}` text of a source still waiting for its variable.
     */
    readonly mountSources: readonly string[]
}

/** A `[[sibling]]` row as the mount detector needs it: its absolute checkout path and variable. */
export interface ComposeSiblingMount {
    readonly slug: string
    readonly var: string
    readonly mount: string
    readonly path: string
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
        const rawVolumes = service.volumes ?? []
        if (!Array.isArray(rawVolumes)) return undefined
        const mountSources: string[] = []
        for (const volume of rawVolumes) {
            const source = record(volume)?.source
            if (source === undefined) continue
            if (typeof source !== 'string') return undefined
            mountSources.push(source)
        }
        projected.push(Object.freeze({
            id, ports: Object.freeze(ports as ComposePublishedPort[]), healthcheck,
            image: image ?? null, build: service.build !== undefined, mountSources: Object.freeze(mountSources),
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

const LEADING_VARIABLE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/

/**
 * Where a volume's host side lands, read from its source as written or as Compose reports it
 * uninterpolated. `variables` are the values cockpit hands Compose (the sibling directories); any
 * other variable resolves to its own default, as it does in `up`, or cannot be resolved at all.
 * Returns the absolute host path of a bind, `'volume'` for a named volume, and `undefined` when the
 * host side cannot be known.
 */
export function composeBindPath(source: string, root: string, variables: Readonly<Record<string, string>>): string | 'volume' | undefined {
    let text = source
    const lead = LEADING_VARIABLE.exec(source)
    if (lead) {
        const name = (lead[1] ?? lead[4])!
        const operator = lead[2]
        const base = Object.hasOwn(variables, name) && operator !== '+' && operator !== ':+' ? variables[name]
            : operator === '-' || operator === ':-' ? lead[3] : undefined
        if (base === undefined) return undefined
        text = base + source.slice(lead[0].length)
    }
    if (text.includes('$')) return undefined
    if (isAbsolute(text)) return resolve(text)
    if (text === '.' || text === '..' || text.startsWith('./') || text.startsWith('../')) return resolve(root, text)
    // `~` is the invoking user's home, which cockpit never hands a container; anything else is a volume name.
    return text.startsWith('~') ? undefined : 'volume'
}

function contains(parent: string, path: string): boolean {
    return path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

function holder(bind: string, declared: readonly string[]): string | undefined {
    return declared.filter(source => contains(source, bind)).sort((left, right) => right.length - left.length)[0]
}

/**
 * Pairs each bind with the deepest declared mount source holding it. A bind of a directory inside
 * a mount = "always" checkout (`./api` of the repository) mounts that checkout, so it counts for
 * it; a bind inside no declared source is undeclared, and a declared source no bind lands in is
 * missing. Both `check` and `up` judge their binds with this one rule.
 */
export function compareBindSources(binds: readonly string[], declared: readonly string[]): Readonly<{
    missing: readonly string[]; unexpected: readonly string[]
}> {
    const used = new Set<string>()
    const unexpected: string[] = []
    for (const bind of new Set(binds)) {
        const owner = holder(bind, declared)
        if (owner === undefined) unexpected.push(bind)
        else used.add(owner)
    }
    return Object.freeze({
        missing: Object.freeze([...new Set(declared)].filter(source => !used.has(source)).sort()),
        unexpected: Object.freeze(unexpected.sort()),
    })
}

async function canonicalPath(path: string): Promise<string> {
    try { return await realpath(path) }
    catch (error) {
        // Compose creates a missing bind source, so the nearest existing ancestor decides where it lands.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
        return join(await canonicalPath(dirname(path)), basename(path))
    }
}

/**
 * The binds inside a declared source whose real path leaves it. Containment above is lexical, and
 * Docker follows a symbolic link in the bind source, so `./api/cache -> /` would otherwise hand
 * the host root to a container under a mount = "always" checkout.
 */
export async function redirectedBindSources(binds: readonly string[], declared: readonly string[]): Promise<readonly Readonly<{
    bind: string; holder: string
}>[]> {
    const redirected: { bind: string; holder: string }[] = []
    for (const bind of new Set(binds)) {
        if (declared.includes(bind)) continue
        const owner = holder(bind, declared)
        if (owner === undefined) continue
        let inside: boolean
        try { inside = contains(await canonicalPath(owner), await canonicalPath(bind)) }
        catch { inside = false }
        if (!inside) redirected.push(Object.freeze({ bind, holder: owner }))
    }
    return Object.freeze(redirected.sort((left, right) => left.bind.localeCompare(right.bind)))
}

export interface ComposeTopologyDeclarations {
    /** Canonical cockpit root; a relative bind source, or a variable's relative default, resolves against it. */
    readonly root: string
    readonly portVariables: readonly string[]
    readonly siblings: readonly ComposeSiblingMount[]
    /** The absolute `environment.generated_host_paths`, which `up` hands to containers beside the checkouts. */
    readonly hostPaths: readonly string[]
}

/**
 * Judges a cockpit's own Compose topology. A host port that is not drawn from a leased
 * `ports.bases` variable is the same number in every worktree and parallel stack, so the second
 * stack to start fails to bind it; the remaining findings are warnings about what cockpit can
 * then promise, not about whether the stack runs.
 */
export async function assessComposeTopology(
    services: readonly ComposeServiceTopology[],
    declarations: ComposeTopologyDeclarations,
): Promise<readonly Diagnostic[]> {
    const leased = new Set(declarations.portVariables)
    const diagnostics: Diagnostic[] = []
    // `up` admits the topology only when every bind lands inside a mount = "always" checkout or a
    // generated host path, and every such checkout is mounted; check judges the same binds the same
    // way, or a configuration check accepts refuses every runtime command.
    const always = declarations.siblings.filter(sibling => sibling.mount === 'always')
    const declared = [...always.map(sibling => sibling.path), ...declarations.hostPaths]
    const variables = Object.fromEntries(declarations.siblings.map(sibling => [sibling.var, sibling.path]))
    const binds = services.flatMap(service => service.mountSources.map(source => ({
        service: service.id, source, path: composeBindPath(source, declarations.root, variables) })))
        .filter(bind => bind.path !== 'volume')
    const resolved = binds.flatMap(bind => bind.path === undefined ? [] : [bind.path])
    const { missing, unexpected } = compareBindSources(resolved, declared)
    const redirected = (await redirectedBindSources(resolved, declared)).map(({ bind }) => bind)
    for (const sibling of always) {
        if (!missing.includes(sibling.path)) continue
        diagnostics.push(Object.freeze({
            severity: 'error' as const, code: 'COMPOSE_SIBLING_NOT_MOUNTED', target: `sibling:${sibling.slug}`,
            message: `sibling ${sibling.slug} is declared mount = "always", but no Compose service bind-mounts ${sibling.path} or a directory inside it; up admits a stack only when every such sibling is mounted, so it would refuse to start`,
            fix: `bind-mount it in a service of the Compose file, whole or a directory inside it (for example "\${${sibling.var}}:/workspace/${sibling.slug}"), or set mount = "none" on sibling ${sibling.slug} in cockpit.toml, then run ${cockpitCommand('sync')}`,
        }))
    }
    for (const bind of binds) {
        const why = bind.path === undefined
            ? 'whose host side names a variable cockpit does not supply and gives it no default'
            : unexpected.includes(bind.path) ? 'which lies inside no mount = "always" sibling and is no environment.generated_host_paths entry'
                : redirected.includes(bind.path) ? 'which resolves through a symbolic link to a path outside the sibling that holds it' : undefined
        if (why === undefined) continue
        diagnostics.push(Object.freeze({
            severity: 'error' as const, code: 'COMPOSE_BIND_UNDECLARED', target: `compose:${bind.service}:${bind.source}`,
            message: `service ${bind.service} bind-mounts ${bind.path ?? bind.source}, ${why}; up hands a container only the checkouts and host paths cockpit.toml declares, so it would refuse to start`,
            fix: `bind a directory inside a mount = "always" sibling (its variable, as in "\${VAR}/path", or a path relative to the cockpit root), list the path under environment.generated_host_paths, or remove the bind mount from service ${bind.service}; then run ${cockpitCommand('check')}`,
        }))
    }
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
