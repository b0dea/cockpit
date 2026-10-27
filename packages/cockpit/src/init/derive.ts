// Proposes interview answers from files a repository already carries. It owns reading those files
// and attributing each proposed value to its source; it must not decide or write anything. Every
// fact is inferred: init surfaces it with its source and the operator confirms it, because a
// config that looks complete but holds guesses is the failure cockpit exists to prevent.
// Deliberately cheap and exact: Dockerfile, .env.example names, Compose files and CI service
// containers. Orchestrator manifests are not parsed; their shape is too varied to read reliably.
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export const mechanism = {
    id: 'init-inference',
    module: 'packages/cockpit/src/init/derive.ts',
    exports: ['deriveInferredFacts'],
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
    readonly root: string
    readonly repositories: readonly Readonly<{ slug: string; path: string }>[]
}

const MAX_BYTES = 1024 * 1024
const MAX_WORKFLOWS = 32
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type Read = { kind: 'absent' } | { kind: 'skipped'; reason: string } | { kind: 'text'; text: string }

async function readBounded(path: string): Promise<Read> {
    let stat
    try { stat = await lstat(path) }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
        return { kind: 'skipped', reason: `could not be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})` }
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: 'skipped', reason: 'is not a regular file' }
    if (stat.size > MAX_BYTES) return { kind: 'skipped', reason: `exceeds the ${MAX_BYTES}-byte inference limit` }
    try { return { kind: 'text', text: await readFile(path, 'utf8') } }
    catch (error) {
        return { kind: 'skipped', reason: `could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})` }
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

interface DockerfileFacts { readonly command?: string[]; readonly ports: number[] }

function readDockerfile(text: string): DockerfileFacts {
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

export async function deriveInferredFacts(input: InferenceInput): Promise<InferenceResult> {
    const facts: InferredFact[] = []
    const skipped: SkippedInference[] = []
    const directories = [{ slug: undefined as string | undefined, path: '' },
        ...input.repositories.map(repository => ({ slug: repository.slug as string | undefined, path: repository.path }))]
    const relative = (directory: string, name: string) => directory === '' ? name : `${directory}/${name}`
    const read = async (directory: string, name: string): Promise<string | undefined> => {
        const source = relative(directory, name)
        const result = await readBounded(join(input.root, source))
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
    const composeFiles: string[] = []
    const seenServices = new Set<string>()

    for (const directory of directories) {
        const slug = directory.slug
        if (slug !== undefined) {
            const dockerfile = await read(directory.path, 'Dockerfile')
            if (dockerfile !== undefined) {
                const source = relative(directory.path, 'Dockerfile')
                const parsed = readDockerfile(dockerfile)
                if (parsed.command) facts.push({ fields: ['estate.runnable', 'environment.generated'], target: `${slug}.command`,
                    value: parsed.command, provenance: { kind: 'inferred', source,
                        reason: 'the final stage of the Dockerfile sets this ENTRYPOINT/CMD' } })
                if (parsed.ports.length > 0) facts.push({ fields: ['environment.generated', 'ports.bases'], target: `${slug}.container_ports`,
                    value: parsed.ports, provenance: { kind: 'inferred', source,
                        reason: 'the final stage of the Dockerfile EXPOSEs these container ports' } })
            }
            const env = await read(directory.path, '.env.example')
            if (env !== undefined) {
                const names = envNames(env)
                if (names.length > 0) facts.push({ fields: ['environment.generated'], target: `${slug}.env_names`, value: names,
                    provenance: { kind: 'inferred', source: relative(directory.path, '.env.example'),
                        reason: 'these variable names appear in .env.example; their values are never read' } })
            }
        }
        for (const name of COMPOSE_NAMES) {
            const source = relative(directory.path, name)
            const text = await read(directory.path, name)
            if (text === undefined) continue
            if (parseYamlText(source, text) !== undefined) composeFiles.push(source)
            break
        }
        const workflowDirectory = relative(directory.path, '.github/workflows')
        let entries: string[] = []
        try { entries = (await readdir(join(input.root, workflowDirectory))).filter(name => /\.ya?ml$/.test(name)).sort() }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
                skipped.push({ source: workflowDirectory, reason: `could not be listed (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})` })
            }
        }
        if (entries.length > MAX_WORKFLOWS) {
            skipped.push({ source: workflowDirectory, reason: `holds more than ${MAX_WORKFLOWS} workflows; only the first ${MAX_WORKFLOWS} were read` })
            entries = entries.slice(0, MAX_WORKFLOWS)
        }
        for (const entry of entries) {
            const source = `${workflowDirectory}/${entry}`
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
    if (composeFiles.length > 0) facts.unshift({ fields: ['environment.generated'], target: 'environment.compose_files', value: composeFiles,
        provenance: { kind: 'inferred', source: composeFiles[0]!,
            reason: composeFiles.length === 1 ? 'a Compose file already exists, so compose-first mode can run it instead of a rendered environment'
                : 'these Compose files already exist, so compose-first mode can run them instead of a rendered environment' } })
    return Object.freeze({ facts: Object.freeze(facts), skipped: Object.freeze(skipped) })
}
