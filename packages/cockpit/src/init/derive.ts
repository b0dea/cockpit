// Proposes interview answers from files a repository already carries. It owns reading those files
// and attributing each proposed value to its source; it must not decide or write anything. Every
// fact is inferred: init surfaces it with its source and the operator confirms it, because a
// config that looks complete but holds guesses is the failure cockpit exists to prevent.
// Deliberately cheap and exact: Dockerfile, env template variable names, Compose files and CI
// service containers. Orchestrator manifests are not parsed; their shape is too varied to read reliably.
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative as pathRelative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readBoundedInput } from '../config/load.js'
import { bindHolder, composeBindPath, splitComposeShort } from '../environment/compose-topology.js'
import { initCommand } from '../fix-catalogue.js'
import { deriveSiblingVariable } from '../schema.js'

export const mechanism = {
    id: 'init-inference',
    module: 'packages/cockpit/src/init/derive.ts',
    exports: ['COMPOSE_NAMES', 'deriveInferredFacts', 'readDockerfileFacts'],
} as const

export interface InferredProvenance {
    readonly kind: 'inferred'
    readonly source: string
    readonly reason: string
}

export interface InferredFact {
    /** Interview fields this fact helps answer. */
    readonly fields: readonly string[]
    readonly target: string
    readonly value: unknown
    readonly provenance: InferredProvenance
}

export interface SkippedInference {
    readonly source: string
    readonly reason: string
}

export interface InferenceResult {
    readonly facts: readonly InferredFact[]
    readonly skipped: readonly SkippedInference[]
}

export interface InferenceInput {
    /** Files must stay under this observed authority root. */
    readonly root: string
    /** Paths surfaced for confirmation are relative to the cockpit that will store them. */
    readonly configurationRoot?: string
    readonly repositories: readonly Readonly<{ slug: string; path: string }>[]
}

const MAX_BYTES = 1024 * 1024
const MAX_WORKFLOWS = 32
export const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SIBLING_SLUG = /^[a-z][a-z0-9-]*$/
// .env.example, .env.staging.example, .env.sample, .env.production.template and the like: files
// meant to be committed, so their names are safe to read. Their values never are.
const ENV_TEMPLATE = /^\.env(?:\.[A-Za-z0-9_-]+)*\.(?:example|sample|template)$/
const MAX_ENV_TEMPLATES = 16
// Names only suggest; the human says which host of which non-local environment each points at.
const DATABASE_VARIABLE = /(?:^|_)(?:DATABASE|DB|POSTGRES(?:QL)?|PG|MYSQL|MARIADB|MONGO(?:DB)?|REDIS)(?:_[A-Z0-9]+)*_(?:URL|URI|DSN|HOST)$|^(?:DATABASE_URL|PGHOST|MONGO_URL|REDIS_URL)$/
const VENDOR_VARIABLE = /_(?:API_)?(?:BASE|BASE_URL|URL|ENDPOINT|HOST)$/

type Read = { kind: 'absent' } | { kind: 'skipped'; reason: string } | { kind: 'text'; text: string }
type DirectoryRead = { kind: 'absent' } | { kind: 'skipped'; reason: string }
    | { kind: 'complete'; path: string; dev: number; ino: number }

async function inspectDirectory(root: string, directory: string): Promise<DirectoryRead> {
    const canonicalRoot = resolve(root)
    const path = resolve(canonicalRoot, directory)
    const confined = pathRelative(canonicalRoot, path)
    if (canonicalRoot !== root || confined === '..' || confined.startsWith(`..${sep}`) || isAbsolute(confined)) {
        return { kind: 'skipped', reason: 'escapes the canonical inference root' }
    }
    try {
        const stat = await lstat(path)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: 'skipped', reason: 'is a redirected directory' }
        const expected = resolve(await realpath(canonicalRoot), directory)
        if (await realpath(path) !== expected) return { kind: 'skipped', reason: 'is a redirected directory' }
        return { kind: 'complete', path, dev: stat.dev, ino: stat.ino }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
        return { kind: 'skipped', reason: `could not be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})` }
    }
}

function sameDirectory(left: DirectoryRead, right: DirectoryRead): boolean {
    return left.kind === 'complete' && right.kind === 'complete'
        && left.path === right.path && left.dev === right.dev && left.ino === right.ino
}

async function readBounded(root: string, directory: string, name: string): Promise<Read> {
    const parent = await inspectDirectory(root, directory)
    if (parent.kind !== 'complete') return parent
    try {
        const read = await readBoundedInput(resolve(parent.path, name))
        if (read.kind === 'too-large' || read.bytes.byteLength > MAX_BYTES) {
            return { kind: 'skipped', reason: `exceeds the ${MAX_BYTES}-byte inference limit` }
        }
        if (!sameDirectory(parent, await inspectDirectory(root, directory))) {
            return { kind: 'skipped', reason: 'directory changed while the file was read' }
        }
        try { return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) } }
        catch { return { kind: 'skipped', reason: 'is not valid UTF-8' } }
    }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return { kind: 'absent' }
        if (code === 'ELOOP' || (error instanceof Error && error.message === 'structured input is not a regular file')) {
            return { kind: 'skipped', reason: 'is not a regular file' }
        }
        return { kind: 'skipped', reason: `could not be read (${code ?? 'unknown I/O error'})` }
    }
}

function joinLogical(text: string): string[] {
    const lines: string[] = []
    let pending = ''
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (pending === '' && (line === '' || line.startsWith('#'))) continue
        if (line.endsWith('\\')) { pending += `${line.slice(0, -1)} `; continue }
        lines.push((pending + line).trim())
        pending = ''
    }
    if (pending.trim() !== '') lines.push(pending.trim())
    return lines
}

function instructionArgv(argument: string): string[] | undefined {
    if (argument === '') return undefined
    // Docker reads an instruction that is not a valid JSON array of strings as shell form.
    const shellForm = ['sh', '-c', argument]
    if (!argument.startsWith('[')) return shellForm
    try {
        const parsed: unknown = JSON.parse(argument)
        return Array.isArray(parsed) && parsed.length > 0 && parsed.every(part => typeof part === 'string') ? parsed as string[] : shellForm
    } catch { return shellForm }
}

export interface DockerfileFacts { readonly command?: string[]; readonly ports: number[] }

export function readDockerfileFacts(text: string): DockerfileFacts {
    // Only the final build stage describes the image that runs.
    let ports: number[] = []
    let entrypoint: string[] | undefined
    let cmd: string[] | undefined
    for (const line of joinLogical(text)) {
        const [keyword = '', ...rest] = line.split(/\s+/)
        const argument = line.slice(keyword.length).trim()
        switch (keyword.toUpperCase()) {
            case 'FROM': ports = []; entrypoint = undefined; cmd = undefined; break
            case 'EXPOSE':
                for (const token of rest) {
                    const match = /^(\d{1,5})(?:\/(?:tcp|udp))?$/i.exec(token)
                    if (match && Number(match[1]) >= 1 && Number(match[1]) <= 65535) ports.push(Number(match[1]))
                }
                break
            case 'ENTRYPOINT': entrypoint = instructionArgv(argument); break
            case 'CMD': cmd = instructionArgv(argument); break
        }
    }
    // A shell-form ENTRYPOINT ignores CMD; an exec-form one receives CMD as arguments.
    const shellEntrypoint = entrypoint?.[0] === 'sh' && entrypoint[1] === '-c' && entrypoint.length === 3
    const command = entrypoint === undefined ? cmd : shellEntrypoint ? entrypoint : [...entrypoint, ...(cmd ?? [])]
    return { ...(command === undefined ? {} : { command }), ports: [...new Set(ports)] }
}

function envNames(text: string): string[] {
    const names = new Set<string>()
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([^=\s#]+)\s*=/.exec(line)
        if (match && ENV_NAME.test(match[1]!)) names.add(match[1]!)
    }
    return [...names].sort()
}

function workflowServices(document: unknown): Array<{ job: string; name: string; image: string }> {
    const jobs = (document as { jobs?: unknown } | null)?.jobs
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return []
    const found: Array<{ job: string; name: string; image: string }> = []
    for (const [job, definition] of Object.entries(jobs as Record<string, unknown>)) {
        const services = (definition as { services?: unknown } | null)?.services
        if (!services || typeof services !== 'object' || Array.isArray(services)) continue
        for (const [name, service] of Object.entries(services as Record<string, unknown>)) {
            const image = (service as { image?: unknown } | null)?.image
            if (typeof image === 'string' && image.trim() !== '') found.push({ job, name, image: image.trim() })
        }
    }
    return found
}

const PORT_VARIABLE = /^\$\{([A-Z][A-Z0-9_]*)(?:(:?-)(\d{1,5}))?\}$|^\$([A-Z][A-Z0-9_]*)$/

function entries(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : []
}

/**
 * Reads the bind sources and published host-port variables of the Compose files init proposes.
 * Bind sources resolve as `up` resolves them: against the cockpit root, with each proposed sibling
 * variable set to its directory and any other variable to its own default.
 */
function composeFacts(
    files: readonly Readonly<{ source: string; document: unknown }>[],
    root: string,
    variables: Readonly<Record<string, string>>,
    skipped: SkippedInference[],
): Readonly<{ binds: readonly Readonly<{ source: string; path: string }>[]; bases: ReadonlyMap<string, number>; basesSource?: string }> {
    const binds: { source: string; path: string }[] = []
    const bases = new Map<string, number>()
    const conflicting = new Set<string>()
    let basesSource: string | undefined
    for (const { source, document } of files) {
        const services = (document as { services?: unknown } | null)?.services
        if (!services || typeof services !== 'object' || Array.isArray(services)) continue
        for (const service of Object.values(services as Record<string, unknown>)) {
            if (!service || typeof service !== 'object') continue
            for (const volume of entries((service as { volumes?: unknown }).volumes)) {
                const segments = typeof volume === 'string' ? splitComposeShort(volume) : undefined
                const raw = segments && segments.length >= 2 ? segments[0]
                    : volume && typeof volume === 'object' && (volume as { type?: unknown }).type === 'bind'
                        ? (volume as { source?: unknown }).source : undefined
                const path = typeof raw === 'string' ? composeBindPath(raw, root, variables) : undefined
                if (path !== undefined && path !== 'volume') binds.push({ source, path })
            }
            for (const port of entries((service as { ports?: unknown }).ports)) {
                const segments = typeof port === 'string' ? splitComposeShort(port) : undefined
                const published = segments && segments.length >= 2 ? segments[segments.length - 2]
                    : port && typeof port === 'object' ? (port as { published?: unknown }).published : undefined
                const match = typeof published === 'string' ? PORT_VARIABLE.exec(published) : null
                if (!match) continue
                const name = (match[1] ?? match[4])!
                const base = match[3] === undefined ? undefined : Number(match[3])
                if (base === undefined || base < 1 || base > 65_535) {
                    skipped.push({ source, reason: `publishes a host port from \${${name}} with no default, so its base port cannot be read; declare ${name} under [ports.bases]` })
                    continue
                }
                if (bases.has(name) && bases.get(name) !== base) conflicting.add(name)
                bases.set(name, base)
                basesSource ??= source
            }
        }
    }
    for (const name of conflicting) {
        bases.delete(name)
        skipped.push({ source: basesSource!, reason: `publishes \${${name}} with different defaults, so its base port cannot be read; declare ${name} under [ports.bases]` })
    }
    return Object.freeze({ binds: Object.freeze(binds), bases, ...(basesSource === undefined ? {} : { basesSource }) })
}

export async function deriveInferredFacts(input: InferenceInput): Promise<InferenceResult> {
    const facts: InferredFact[] = []
    const skipped: SkippedInference[] = []
    const configurationRoot = input.configurationRoot ?? input.root
    // A repository at "." is the cockpit root itself (an in-repo cockpit), so the root is read once, as that repository.
    const ownRoot = configurationRoot === input.root ? input.repositories.find(repository => repository.path === '.') : undefined
    const configurationDirectory = pathRelative(input.root, configurationRoot)
    const directories = [{ slug: ownRoot?.slug, path: configurationDirectory },
        ...input.repositories.filter(repository => repository !== ownRoot)
            .map(repository => ({ slug: repository.slug as string | undefined, path: repository.path }))]
    const relative = (directory: string, name = '') => {
        const source = pathRelative(configurationRoot, resolve(input.root, directory, name))
        return (source === '' ? '.' : source).split(sep).join('/')
    }
    const authorityRelative = (directory: string, name: string) =>
        pathRelative(input.root, resolve(input.root, directory, name)) || '.'
    const read = async (directory: string, name: string): Promise<string | undefined> => {
        const source = relative(directory, name)
        const result = await readBounded(input.root, directory, name)
        if (result.kind === 'skipped') skipped.push({ source, reason: result.reason })
        return result.kind === 'text' ? result.text : undefined
    }
    const parseYamlText = (source: string, text: string): unknown => {
        try { return parseYaml(text) }
        catch (error) {
            skipped.push({ source, reason: `is not valid YAML (${error instanceof Error ? error.name : 'parse error'})` })
            return undefined
        }
    }
    const composeFiles: { source: string; document: unknown }[] = []
    const seenServices = new Set<string>()

    for (const directory of directories) {
        const slug = directory.slug
        if (slug !== undefined) {
            const dockerfile = await read(directory.path, 'Dockerfile')
            if (dockerfile !== undefined) {
                const source = relative(directory.path, 'Dockerfile')
                const parsed = readDockerfileFacts(dockerfile)
                if (parsed.command) facts.push({ fields: ['estate.runnable', 'environment.generated'], target: `${slug}.command`,
                    value: parsed.command, provenance: { kind: 'inferred', source,
                        reason: 'the final stage of the Dockerfile sets this ENTRYPOINT/CMD' } })
                if (parsed.ports.length > 0) facts.push({ fields: ['environment.generated', 'ports.bases'], target: `${slug}.container_ports`,
                    value: parsed.ports, provenance: { kind: 'inferred', source,
                        reason: 'the final stage of the Dockerfile EXPOSEs these container ports' } })
            }
        }
        let templates: string[] = []
        const templateDirectory = await inspectDirectory(input.root, directory.path)
        if (templateDirectory.kind === 'complete') {
            try {
                templates = (await readdir(templateDirectory.path)).filter(name => ENV_TEMPLATE.test(name)).sort()
                if (!sameDirectory(templateDirectory, await inspectDirectory(input.root, directory.path))) {
                    templates = []
                    skipped.push({ source: relative(directory.path), reason: 'directory changed while it was listed' })
                }
            } catch (error) {
                skipped.push({ source: relative(directory.path),
                    reason: `could not be listed (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})` })
            }
        } else if (templateDirectory.kind === 'skipped') {
            skipped.push({ source: relative(directory.path), reason: templateDirectory.reason })
        }
        if (templates.length > MAX_ENV_TEMPLATES) {
            skipped.push({ source: relative(directory.path),
                reason: `holds more than ${MAX_ENV_TEMPLATES} env template files; only the first ${MAX_ENV_TEMPLATES} were read` })
            templates = templates.slice(0, MAX_ENV_TEMPLATES)
        }
        for (const template of templates) {
            const text = await read(directory.path, template)
            if (text === undefined) continue
            const source = relative(directory.path, template)
            const names = envNames(text)
            if (slug !== undefined && template === '.env.example' && names.length > 0) facts.push({ fields: ['environment.generated'],
                target: `${slug}.env_names`, value: names,
                provenance: { kind: 'inferred', source, reason: 'these variable names appear in .env.example; their values are never read' } })
            for (const name of names) {
                const target = DATABASE_VARIABLE.test(name) ? 'guards.hosted_db_hosts'
                    : VENDOR_VARIABLE.test(name) ? 'guards.vendor_endpoint_hosts' : undefined
                if (target === undefined) continue
                facts.push({ fields: ['guards'], target, value: { variable: name,
                    ask: `which host does ${name} point at in each non-local environment (production, staging, shared)?` },
                    provenance: { kind: 'inferred', source,
                        reason: `the variable name ${name} suggests ${target === 'guards.hosted_db_hosts' ? 'a database' : 'a vendor API endpoint'}; its value was never read, so the host comes from the human` } })
            }
        }
        for (const name of COMPOSE_NAMES) {
            const source = relative(directory.path, name)
            const text = await read(directory.path, name)
            if (text === undefined) continue
            const document = parseYamlText(source, text)
            if (document !== undefined) {
                if (source === '..' || source.startsWith('../') || isAbsolute(source)) {
                    skipped.push({ source,
                        reason: `is outside the cockpit root, so environment.compose_files cannot represent it; choose generated environment configuration, or place a reviewed Compose file inside the cockpit root and rerun ${initCommand({ root: configurationRoot })} with the options you ran it with` })
                } else composeFiles.push({ source, document })
            }
            break
        }
        const workflowDirectory = authorityRelative(directory.path, '.github/workflows')
        const workflowSource = relative(directory.path, '.github/workflows')
        let entries: string[] = []
        const workflow = await inspectDirectory(input.root, workflowDirectory)
        if (workflow.kind === 'complete') {
            try {
                entries = (await readdir(workflow.path)).filter(name => /\.ya?ml$/.test(name)).sort()
                if (!sameDirectory(workflow, await inspectDirectory(input.root, workflowDirectory))) {
                    entries = []
                    skipped.push({ source: workflowSource, reason: 'directory changed while it was listed' })
                }
            } catch (error) {
                skipped.push({ source: workflowSource, reason: `could not be listed (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})` })
            }
        } else if (workflow.kind === 'skipped') {
            skipped.push({ source: workflowSource, reason: workflow.reason })
        }
        if (entries.length > MAX_WORKFLOWS) {
            skipped.push({ source: workflowSource, reason: `holds more than ${MAX_WORKFLOWS} workflows; only the first ${MAX_WORKFLOWS} were read` })
            entries = entries.slice(0, MAX_WORKFLOWS)
        }
        for (const entry of entries) {
            const source = relative(workflowDirectory, entry)
            const text = await read(workflowDirectory, entry)
            if (text === undefined) continue
            for (const service of workflowServices(parseYamlText(source, text))) {
                const key = `${service.name}\0${service.image}`
                if (seenServices.has(key)) continue
                seenServices.add(key)
                facts.push({ fields: ['environment.generated'], target: `services.${service.name}`, value: { image: service.image },
                    provenance: { kind: 'inferred', source,
                        reason: `workflow job "${service.job}" runs the backing service "${service.name}" from this image` } })
            }
        }
    }
    // With no repository under the root, the cockpit root is the first one: an empty directory
    // the product will grow in, or a repository of documents. The schema needs one sibling, and
    // declaring the root itself (dir ".") says what is true instead of inventing a child directory
    // or allowing a cockpit with no repositories that every sibling consumer would have to special-case.
    const rootName = basename(configurationRoot)
    const proposesRoot = (input.repositories.length === 0 || ownRoot?.slug === rootName) && SIBLING_SLUG.test(rootName)
    const others = input.repositories.filter(repository => repository !== ownRoot && SIBLING_SLUG.test(repository.slug))
    const siblingPaths = new Map([...proposesRoot ? [[deriveSiblingVariable(rootName), configurationRoot] as const] : [],
        ...others.map(repository => [deriveSiblingVariable(repository.slug), resolve(input.root, repository.path)] as const)])
    const compose = composeFacts(composeFiles, configurationRoot, Object.fromEntries(siblingPaths), skipped)
    if (proposesRoot) {
        // The agent already works in the root, so mounting it buys nothing by itself; but check and
        // up refuse a bind inside a mount = "none" sibling, so a Compose file that binds the root, or
        // a directory of it, makes it a mount = "always" sibling.
        const bind = compose.binds.find(row => bindHolder(row.path, [...siblingPaths.values()]) === configurationRoot)
        const placed = ownRoot ? 'the cockpit lives inside this product repository, so the repository is its own first sibling'
            : 'no directory under the root has a package manifest, so the cockpit root itself is the first repository'
        facts.push({ fields: ['sibling'], target: `sibling.${rootName}`,
            value: { slug: rootName, dir: '.', mount: bind ? 'always' : 'none', acquire: 'none', var: deriveSiblingVariable(rootName) },
            provenance: { kind: 'inferred', source: bind?.source ?? '.', reason: bind
                ? `${placed}; ${bind.source} bind-mounts ${bind.path === configurationRoot ? 'it' : `${pathRelative(configurationRoot, bind.path).split(sep).join('/')} inside it`}, so it is mounted; add its purpose`
                : `${placed}; add its purpose` } })
    }
    // Each observed repository is a checkout the agent works in from the cockpit, so it is mounted;
    // acquire "none" because it already exists here and no remote was read. The purpose is the human's.
    for (const repository of others) {
        facts.push({ fields: ['sibling'], target: `sibling.${repository.slug}`,
            value: { slug: repository.slug, dir: repository.path, mount: 'always', acquire: 'none', var: deriveSiblingVariable(repository.slug) },
            provenance: { kind: 'inferred', source: relative(repository.path),
                reason: 'this repository was observed in the estate, so it is proposed as a sibling with its directory name; add its purpose' } })
    }
    if (compose.bases.size > 0) facts.push({ fields: ['ports.bases'], target: 'ports.bases', value: Object.fromEntries(compose.bases),
        provenance: { kind: 'inferred', source: compose.basesSource!,
            reason: 'the Compose file publishes these host ports from variables with these defaults; check requires every published host port to come from a [ports.bases] variable, so each stack leases its own' } })
    if (composeFiles.length > 0) facts.unshift({ fields: ['environment.generated'], target: 'environment.compose_files', value: composeFiles.map(file => file.source),
        provenance: { kind: 'inferred', source: composeFiles[0]!.source,
            reason: composeFiles.length === 1 ? 'a Compose file already exists, so compose-first mode can run it instead of a rendered environment'
                : 'these Compose files already exist, so compose-first mode can run them instead of a rendered environment' } })
    return Object.freeze({ facts: Object.freeze(facts), skipped: Object.freeze(skipped) })
}
