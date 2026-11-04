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
import { snapshotExecutionStep, type Diagnostic, type ENVIRONMENT_CODES, type ExecutionStep, hasErrorCode } from './contract.js'
import type { ResolvedExecutable } from './executable.js'
import { redactSensitiveText } from './sensitive.js'
import { cockpitCommand } from '../fix-catalogue.js'

/**
 * The directory every relative path in a cockpit's own Compose files resolves against: the first
 * file's, as `docker compose -f first.yml -f second.yml` takes it. Compose cannot default it itself
 * because it reads snapshots of the files, and the cockpit root is the wrong default: a product
 * repository's Compose file names `./api` relative to the repository.
 */
export function composeProjectDirectory(root: string, references: readonly string[]): string {
    return dirname(resolve(root, references[0]!))
}

export interface ComposeTopologyInput {
    /** Canonical absolute cockpit root. */
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
    /** The host interface exactly as written, `null` when none is given, so Docker binds every interface. */
    readonly hostIp: string | null
    readonly target: string
}

export interface ComposeServiceTopology {
    readonly id: string
    readonly ports: readonly ComposePublishedPort[]
    readonly healthcheck: boolean
    readonly image: string | null
    readonly build: boolean
    /** The service's fixed `container_name`, `null` when Compose names the container itself. */
    readonly containerName: string | null
    /**
     * Each volume source as Compose reports it without interpolation: the absolute host path of a
     * bind, or the raw `${VAR}` text of a source still waiting for its variable.
     */
    readonly mountSources: readonly string[]
    /** The Compose profiles that enable the service; absent or empty when it always runs. */
    readonly profiles?: readonly string[]
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
    return { kind: 'unavailable', reason }
}

type ComposeFiles = readonly Readonly<{ path: string; sha256: string }>[]

function topologyStep(input: ComposeTopologyInput, composeFiles: ComposeFiles): ExecutionStep | undefined {
    const fileArgs = composeFiles.flatMap(({ path }) => ['--file', path])
    return snapshotExecutionStep({
        id: `compose-topology:${input.projectName}`,
        argv: [input.docker.canonicalPath, 'compose', '--project-directory', composeProjectDirectory(input.root, input.references), ...fileArgs,
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

/**
 * Splits a Compose short-syntax entry (`[ip:]host:container[/proto]`, `source:target[:mode]`) on
 * its colons. Variable references and bracketed IPv6 addresses are kept whole so their colons do
 * not split the entry; an unbalanced one returns `undefined`.
 */
export function splitComposeShort(value: string): readonly string[] | undefined {
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
    segments.push(current)
    return depth !== 0 || bracket ? undefined : segments
}

// Compose keeps a port it could not interpolate in its short form, and normalises literal ports
// to the long form. Both are read here.
function shortPort(value: string): ComposePublishedPort | undefined {
    const split = splitComposeShort(value)
    if (!split) return undefined
    const segments = [...split.slice(0, -1), split[split.length - 1]!.replace(/\/(?:tcp|udp|sctp)$/, '')]
    if (segments.length > 3 || segments.some((segment, index) => segment === '' && index === segments.length - 1)) return undefined
    if (segments.length === 1) return { published: null, hostIp: null, target: segments[0]! }
    const published = segments[segments.length - 2]!
    const hostIp = segments.length === 3 && segments[0] !== '' ? segments[0]! : null
    return { published: published === '' ? null : published, hostIp, target: segments[segments.length - 1]! }
}

function longPort(value: Record<string, unknown>): ComposePublishedPort | undefined {
    const target = value.target
    const published = value.published
    const hostIp = value.host_ip
    if (typeof target !== 'number' && typeof target !== 'string') return undefined
    if (hostIp !== undefined && hostIp !== null && typeof hostIp !== 'string') return undefined
    const ip = hostIp === undefined || hostIp === null || hostIp === '' ? null : hostIp
    if (published === undefined || published === null || published === '') return { published: null, hostIp: ip, target: String(target) }
    if (typeof published !== 'number' && typeof published !== 'string') return undefined
    return { published: String(published), hostIp: ip, target: String(target) }
}

/** A service's raw `ports` entries, short or long form, or undefined when one cannot be read. */
export function composePublishedPorts(rawPorts: unknown = []): readonly ComposePublishedPort[] | undefined {
    if (!Array.isArray(rawPorts)) return undefined
    const ports = rawPorts.map(port => typeof port === 'string' ? shortPort(port) : record(port) ? longPort(record(port)!) : undefined)
    return ports.every(port => port !== undefined) ? ports : undefined
}

function projectServices(stdout: Buffer): readonly ComposeServiceTopology[] | undefined {
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)) } catch { return undefined } // The caller refuses output that is not UTF-8 JSON; parser text would quote it.
    const services = record(record(parsed)?.services)
    if (!services) return undefined
    const names = Object.keys(services).sort()
    if (names.length > SERVICE_LIMIT || names.some(name => !SERVICE_ID.test(name))) return undefined
    const projected: ComposeServiceTopology[] = []
    for (const id of names) {
        const service = record(services[id])
        if (!service) return undefined
        const ports = composePublishedPorts(service.ports)
        if (!ports) return undefined
        const health = service.healthcheck === undefined ? undefined : record(service.healthcheck)
        if (service.healthcheck !== undefined && !health) return undefined
        const test = health?.test
        const healthcheck = health !== undefined && health.disable !== true
            && !(Array.isArray(test) && test[0] === 'NONE')
        const image = service.image
        if (image !== undefined && typeof image !== 'string') return undefined
        const containerName = service.container_name
        if (containerName !== undefined && typeof containerName !== 'string') return undefined
        const profiles = service.profiles ?? []
        if (!Array.isArray(profiles) || profiles.some(profile => typeof profile !== 'string')) return undefined
        const rawVolumes = service.volumes ?? []
        if (!Array.isArray(rawVolumes)) return undefined
        const mountSources: string[] = []
        for (const volume of rawVolumes) {
            const source = record(volume)?.source
            if (source === undefined) continue
            if (typeof source !== 'string') return undefined
            mountSources.push(source)
        }
        projected.push({
            id, ports, healthcheck,
            image: image ?? null, build: service.build !== undefined, containerName: containerName ?? null, mountSources,
            ...profiles.length > 0 ? { profiles: profiles as string[] } : {},
        })
    }
    return projected
}

/** Runs Compose's own resolution of the declared files and projects the services it reports. */
export async function observeComposeTopology(
    input: ComposeTopologyInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<ComposeTopologyObservation> {
    if (input.references.length === 0) return unavailable('no Compose file is declared')
    const reads = await readAnchoredBatches(input.root, input.references.map(path => ({
        path, maxBytes: OUTPUT_LIMIT_BYTES, action: 'read-file' as const,
    })), input.node, { execute })
    const composeFiles = reads?.kind === 'complete' && reads.results.length === input.references.length
        ? reads.results.map((read, index) => read.kind === 'complete'
            ? { path: resolve(input.root, input.references[index]!), sha256: read.sha256 } : undefined)
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
    return services ? { kind: 'complete', services } : unavailable('docker compose config returned a topology this probe cannot read')
}

export function variableName(value: string): string | undefined {
    return /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:]?[-?+][^}]*)?\}$/.exec(value)?.[1] ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)?.[1]
}

function suggestedVariable(service: string): string {
    return `${service.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_HOST_PORT`
}

const LEADING_VARIABLE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/

/**
 * Where a volume's host side lands, read from its source as written or as Compose reports it
 * uninterpolated; a relative path resolves against `directory`, the Compose project directory.
 * `variables` are the values cockpit hands Compose (the sibling directories); any other variable
 * resolves to its own default, as it does in `up`, or cannot be resolved at all. Returns the
 * absolute host path of a bind, `'volume'` for a named volume, and `undefined` when the host side
 * cannot be known.
 */
export function composeBindPath(source: string, directory: string, variables: Readonly<Record<string, string>>): string | 'volume' | undefined {
    // `config --no-interpolate` still resolves paths, so it joins a long-syntax source that starts
    // with a variable to the project directory as if it were relative: `${API_DIR}` comes back as
    // `<project>/${API_DIR}`. Interpolated, an absolute value replaces that directory and a relative
    // one stays inside it, which is what resolving the variable form against `directory` does.
    const written = directory !== sep && source.startsWith(`${directory}${sep}$`) ? source.slice(directory.length + 1) : source
    let text = written
    const lead = LEADING_VARIABLE.exec(written)
    if (lead) {
        const name = (lead[1] ?? lead[4])!
        const operator = lead[2]
        const base = Object.hasOwn(variables, name) && operator !== '+' && operator !== ':+' ? variables[name]
            : operator === '-' || operator === ':-' ? lead[3] : undefined
        if (base === undefined) return undefined
        text = base + written.slice(lead[0].length)
    }
    if (text.includes('$')) return undefined
    if (isAbsolute(text)) return resolve(text)
    if (text === '.' || text === '..' || text.startsWith('./') || text.startsWith('../')) return resolve(directory, text)
    // `~` is the invoking user's home, which cockpit never hands a container; anything else is a volume name.
    return text.startsWith('~') ? undefined : 'volume'
}

function contains(parent: string, path: string): boolean {
    return path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/** The deepest declared mount source holding `bind`, or `undefined` when none does. */
export function bindHolder(bind: string, declared: readonly string[]): string | undefined {
    return declared.filter(source => contains(source, bind)).sort((left, right) => right.length - left.length)[0]
}

/**
 * Pairs each bind with the deepest declared mount source holding it. A bind of a directory inside
 * a mount = "always" checkout (`./api` of the repository) mounts that checkout, so it counts for
 * it; a bind inside no declared source is undeclared. A declared source is mounted when a bind
 * lands in it or when an admitted bind holds it: a generated host path inside a checkout bound
 * whole reaches the container through that bind, and nothing it is declared for (reset deleting
 * it, the ignore block, the browser writing there) needs a mount of its own. Any other declared
 * source is missing. Both `check` and `up` judge their binds with this one rule.
 */
export function compareBindSources(binds: readonly string[], declared: readonly string[]): Readonly<{
    missing: readonly string[]; unexpected: readonly string[]
}> {
    const used = new Set<string>()
    const admitted: string[] = []
    const unexpected: string[] = []
    for (const bind of new Set(binds)) {
        const owner = bindHolder(bind, declared)
        if (owner === undefined) unexpected.push(bind)
        else { used.add(owner); admitted.push(bind) }
    }
    return {
        missing: [...new Set(declared)]
            .filter(source => !used.has(source) && !admitted.some(bind => contains(bind, source))).sort(),
        unexpected: unexpected.sort(),
    }
}

async function canonicalPath(path: string): Promise<string> {
    try { return await realpath(path) }
    catch (error) {
        // Compose creates a missing bind source, so the nearest existing ancestor decides where it lands.
        if (!hasErrorCode(error, 'ENOENT') || dirname(path) === path) throw error
        return join(await canonicalPath(dirname(path)), basename(path))
    }
}

/**
 * The binds inside a declared source whose real path leaves it. Containment above is lexical, and
 * Docker follows a symbolic link in the bind source, so `./api/cache -> /` would otherwise hand
 * the host root to a container under a mount = "always" checkout.
 */
export async function redirectedBindSources(binds: readonly string[], declared: readonly string[], resolve: (path: string) => Promise<string> = canonicalPath): Promise<readonly Readonly<{
    bind: string; holder: string
}>[]> {
    const redirected: { bind: string; holder: string }[] = []
    for (const bind of new Set(binds)) {
        if (declared.includes(bind)) continue
        const owner = bindHolder(bind, declared)
        if (owner === undefined) continue
        let inside: boolean
        try { inside = contains(await resolve(owner), await resolve(bind)) }
        catch { inside = false } // A bind that cannot be resolved cannot be shown to sit inside its holder, so it is reported redirected and refused.
        if (!inside) redirected.push({ bind, holder: owner })
    }
    return redirected.sort((left, right) => left.bind.localeCompare(right.bind))
}

export interface ComposeTopologyDeclarations {
    /** From composeProjectDirectory; a relative bind source, or a variable's relative default, resolves against it. */
    readonly projectDirectory: string
    readonly portVariables: readonly string[]
    readonly siblings: readonly ComposeSiblingMount[]
    /** The `environment.generated_host_paths`, as declared and absolute, which `up` hands to containers beside the checkouts. */
    readonly hostPaths: readonly Readonly<{ declared: string; path: string }>[]
    /** The `environment.profiles` every `up` activates. */
    readonly profiles?: readonly string[]
}

function profileOf(sibling: ComposeSiblingMount): string | undefined {
    return sibling.mount.startsWith('profile:') ? sibling.mount.slice('profile:'.length) : undefined
}

// Image references that differ per stack: Compose's own project name, which cockpit derives per
// checkout, and the leased ports.bases variables.
function imageVariesPerStack(image: string, leased: ReadonlySet<string>): boolean {
    return [...image.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].some(([, name]) => name === 'COMPOSE_PROJECT_NAME' || leased.has(name!))
}

// The bind findings of the services one profile set runs, judged as `up` judges them under that set.
async function assessBinds(
    services: readonly ComposeServiceTopology[],
    declarations: ComposeTopologyDeclarations,
    variables: Readonly<Record<string, string>>,
    active: readonly string[],
    resolve: (path: string) => Promise<string>,
): Promise<readonly Diagnostic[]> {
    const diagnostics: Diagnostic[] = []
    const running = services.filter(service => !service.profiles?.length || service.profiles.some(profile => active.includes(profile)))
    const mounted = declarations.siblings.filter(sibling => sibling.mount === 'always'
        || profileOf(sibling) !== undefined && active.includes(profileOf(sibling)!))
    const declared = [...mounted.map(sibling => sibling.path), ...declarations.hostPaths.map(({ path }) => path)]
    const binds = running.flatMap(service => service.mountSources.map(source => ({
        service: service.id, source, path: composeBindPath(source, declarations.projectDirectory, variables) })))
        .filter(bind => bind.path !== 'volume')
    const resolved = binds.flatMap(bind => bind.path === undefined ? [] : [bind.path])
    const { missing, unexpected } = compareBindSources(resolved, declared)
    const redirected = (await redirectedBindSources(resolved, declared, resolve)).map(({ bind }) => bind)
    const under = active.length === 0 ? '' : ` with profile ${active.join(', ')} active`
    for (const sibling of mounted) {
        if (!missing.includes(sibling.path)) continue
        diagnostics.push({
            severity: 'error' as const, code: 'COMPOSE_SIBLING_NOT_MOUNTED', target: `sibling:${sibling.slug}`,
            message: `sibling ${sibling.slug} is declared mount = "${sibling.mount}", but no Compose service${under} bind-mounts ${sibling.path} or a directory inside it; up admits a stack only when every such sibling is mounted, so it would refuse to start`,
            fix: `bind-mount it in a service of the Compose file, whole or a directory inside it (for example "\${${sibling.var}}:/workspace/${sibling.slug}"), or set mount = "none" on sibling ${sibling.slug} in cockpit.toml, then run ${cockpitCommand('sync')}`,
        })
    }
    for (const hostPath of declarations.hostPaths) {
        if (!missing.includes(hostPath.path)) continue
        diagnostics.push({
            severity: 'error' as const, code: 'GENERATED_HOST_PATH_UNMOUNTED' as const satisfies typeof ENVIRONMENT_CODES.GENERATED_HOST_PATH_UNMOUNTED,
            target: `environment.generated_host_paths:${hostPath.declared}`,
            message: `environment.generated_host_paths lists ${hostPath.declared}, but no Compose service bind-mounts ${hostPath.path}, a path inside it or a directory that holds it; up admits a stack only when every declared host path is mounted, so it would refuse to start`,
            fix: `bind-mount ${hostPath.declared} in a service of the Compose file, or remove "${hostPath.declared}" from environment.generated_host_paths in cockpit.toml; then run ${cockpitCommand('check')}`,
        })
    }
    for (const bind of binds) {
        const why = bind.path === undefined
            ? 'whose host side names a variable cockpit does not supply and gives it no default'
            : unexpected.includes(bind.path) ? `which lies inside no mounted sibling${under} and is no environment.generated_host_paths entry`
                : redirected.includes(bind.path) ? 'which resolves through a symbolic link to a path outside the sibling that holds it' : undefined
        if (why === undefined) continue
        diagnostics.push({
            severity: 'error' as const, code: 'COMPOSE_BIND_UNDECLARED', target: `compose:${bind.service}:${bind.source}`,
            message: `service ${bind.service} bind-mounts ${bind.path ?? bind.source}, ${why}; up hands a container only the checkouts and host paths cockpit.toml declares, so it would refuse to start`,
            fix: `bind a directory inside a mounted sibling (its variable, as in "\${VAR}/path", or a path relative to the first Compose file's directory), list the path under environment.generated_host_paths, or remove the bind mount from service ${bind.service}; then run ${cockpitCommand('check')}`,
        })
    }
    return diagnostics
}

/**
 * Judges a cockpit's own Compose topology. A host port that is not drawn from a leased
 * `ports.bases` variable is the same number in every worktree and parallel stack, so the second
 * stack to start fails to bind it; a fixed `container_name` fails the same way, and a fixed tag on a
 * built image is shared the same way. The remaining findings are warnings about what cockpit can
 * then promise, not about whether the stack runs.
 */
export async function assessComposeTopology(
    services: readonly ComposeServiceTopology[],
    declarations: ComposeTopologyDeclarations,
): Promise<readonly Diagnostic[]> {
    const leased = new Set(declarations.portVariables)
    const diagnostics: Diagnostic[] = []
    const defined = new Set(services.flatMap(service => service.profiles ?? []))
    const defaults = declarations.profiles ?? []
    for (const [profile, source] of [
        ...defaults.map(profile => [profile, 'environment.profiles names it'] as const),
        ...declarations.siblings.flatMap(sibling => profileOf(sibling) === undefined ? []
            : [[profileOf(sibling)!, `sibling ${sibling.slug} is mounted under it`] as const]),
    ]) {
        if (defined.has(profile)) continue
        diagnostics.push({
            severity: 'error' as const, code: 'COMPOSE_PROFILE_UNDEFINED' as const satisfies typeof ENVIRONMENT_CODES.COMPOSE_PROFILE_UNDEFINED,
            target: `profile:${profile}`,
            message: `profile ${profile} is declared by no service in environment.compose_files, and ${source}; Compose accepts an unknown profile silently, so activating it would start nothing`,
            fix: `add profiles: [${profile}] to the services it should start, or remove it from cockpit.toml; then run ${cockpitCommand('check')}`,
        })
    }
    // `up` admits the topology only when every bind of an active service lands inside a mounted
    // checkout or a generated host path, and every such checkout is mounted; check judges the same
    // binds the same way, or a configuration check accepts refuses every runtime command. A stack
    // runs the default profile set plus any profiles `up --profile` adds, so the binds are judged
    // under the default set and under the default set plus each other defined profile: a finding
    // under several added profiles already shows under one of them.
    const usable = defaults.filter(profile => defined.has(profile))
    const sets = [usable, ...[...defined].filter(profile => !usable.includes(profile)).sort().map(profile => [...usable, profile])]
    const variables = Object.fromEntries(declarations.siblings.map(sibling => [sibling.var, sibling.path]))
    // The same binds recur in most profile sets, so each real path is resolved once.
    const resolutions = new Map<string, Promise<string>>()
    const resolve = (path: string) => {
        let resolution = resolutions.get(path)
        if (resolution === undefined) { resolution = canonicalPath(path); resolutions.set(path, resolution) }
        return resolution
    }
    const seen = new Set<string>()
    for (const active of sets) {
        for (const diagnostic of await assessBinds(services, declarations, variables, active, resolve)) {
            const key = `${diagnostic.code}\0${diagnostic.target}`
            if (!seen.has(key)) { seen.add(key); diagnostics.push(diagnostic) }
        }
    }
    for (const service of services) {
        for (const port of service.ports) {
            // No host interface means Docker binds every one (0.0.0.0 and ::), exposing the service
            // to the network. Writing an interface, even 0.0.0.0, is the declared way to mean it.
            if (port.hostIp === null) diagnostics.push({
                severity: 'warning' as const, code: 'COMPOSE_PORT_ALL_INTERFACES', target: `compose:${service.id}:${port.target}`,
                message: `service ${service.id} publishes container port ${port.target} with no host interface, so Docker binds every interface and the service is reachable from the network`,
                fix: `write the host interface in front of the port, as "127.0.0.1:\${${(port.published === null ? undefined : variableName(port.published)) ?? suggestedVariable(service.id)}}:${port.target}", or write 0.0.0.0 there if you mean the wider exposure`,
            })
            if (port.published === null) continue
            const variable = variableName(port.published)
            if (variable !== undefined && leased.has(variable)) continue
            const name = variable ?? suggestedVariable(service.id)
            diagnostics.push({
                severity: 'error' as const, code: 'COMPOSE_PORT_NOT_LEASED', target: `compose:${service.id}:${port.target}`,
                message: `service ${service.id} publishes host port ${JSON.stringify(port.published)} for container port ${port.target}, which is not taken from a ports.bases variable; the same host port collides across worktrees and parallel stacks`,
                fix: `publish it as "\${${name}}:${port.target}" in the Compose file and declare ${name} under [ports.bases]`,
            })
        }
        if (service.containerName !== null) diagnostics.push({
            severity: 'error' as const, code: 'COMPOSE_CONTAINER_NAME_FIXED', target: `compose:${service.id}`,
            message: `service ${service.id} sets container_name ${JSON.stringify(service.containerName)}, and Docker allows one container of a name, so a second checkout's stack fails to start`,
            fix: `remove container_name from service ${service.id} and address it by its Compose service name, or with docker compose exec ${service.id}`,
        })
        if (!service.healthcheck) diagnostics.push({
            severity: 'warning' as const, code: 'COMPOSE_HEALTHCHECK_MISSING', target: `compose:${service.id}`,
            message: `service ${service.id} declares no Compose healthcheck, so running is treated as ready`,
            fix: `add a healthcheck to service ${service.id} that succeeds only once it serves requests`,
        })
        if (!service.build && service.image !== null && !PINNED_IMAGE.test(service.image)) diagnostics.push({
            severity: 'warning' as const, code: 'COMPOSE_IMAGE_UNPINNED', target: `compose:${service.id}`,
            message: `service ${service.id} runs image ${JSON.stringify(service.image)} by tag, so a later pull can change what runs`,
            fix: `pin it by digest, for example ${service.image.replace(/:[^/:]*$/, '')}@sha256:<digest> from docker image inspect`,
        })
        if (service.build && service.image !== null && !imageVariesPerStack(service.image, leased)) diagnostics.push({
            severity: 'error' as const, code: 'COMPOSE_IMAGE_TAG_SHARED', target: `compose:${service.id}`,
            message: `service ${service.id} builds its image and tags it ${JSON.stringify(service.image)}, which is the same in every worktree and parallel stack, so one checkout's build replaces the image another checkout's stack runs`,
            fix: `remove image from service ${service.id}, so Compose names the build after this stack's project`,
        })
    }
    return diagnostics
}
