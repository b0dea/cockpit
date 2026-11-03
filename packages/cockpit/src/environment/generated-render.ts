import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import { stringify as stringifyYaml } from 'yaml'

import { DECISIONS_PATH, decisionSubjects, GeneratedEnvironment, type GeneratedEnvironment as GeneratedEnvironmentDeclaration, type Provenance } from '../schema.js'
import { snapshotGeneratedJson, type StackId } from './contract.js'
import { externalDependencyTemplateFragments } from './templates.js'

export const mechanism = {
    id: 'generated-compose-authority',
    module: 'packages/cockpit/src/environment/generated-render.ts',
    exports: ['renderGeneratedEnvironment', 'authenticateGeneratedRender', 'projectGeneratedComposeArtifactAuthority', 'authenticateGeneratedComposeArtifact', 'projectGeneratedComposeRuntimeIdentity'],
} as const

const SHA256 = /^[a-f0-9]{64}$/
const STACK_ID = /^stack:[a-f0-9]{64}$/
const COCKPIT_ID = /^cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}$/
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\\\x00-\x1f\x7f]).+$/
const MAX_SOURCE_BYTES = 16_777_216

type Operation = GeneratedEnvironmentDeclaration['services'][number]['health']['probe']

export interface GeneratedEnvironmentInput {
    readonly declaration: unknown
    /** `runtimeDeclarationSha256` of the configuration, not its file bytes: it becomes the stack's ownership labels. */
    readonly sourceSha256: string
    readonly generation: string
    readonly stackId: string
    readonly cockpitId: string
    readonly portDefaults: Readonly<Record<string, number>>
    readonly siblingDirectories: Readonly<Record<string, string>>
    readonly browserRunner?: Readonly<{
        service: unknown
    }>
}

export interface GeneratedOwnedFile {
    readonly path: string
    readonly bytes: string
    readonly sha256: string
    readonly sourceSha256: string
    readonly generation: string
    readonly ownership: 'whole-file'
}

interface GeneratedObservationBase {
    readonly id: string
    readonly target: string
    readonly expected: Readonly<Record<string, unknown>>
}

export type GeneratedObservationPlan = Readonly<GeneratedObservationBase & ({
    readonly kind: 'image-startup-launcher'
    readonly launcher: Readonly<{
        readonly image: string
        readonly entrypoint: '/bin/sh'
        readonly argv: readonly [string, ...string[]]
        readonly timeoutSeconds: number
    }>
} | {
    readonly kind: 'mount-lstat' | 'registry-auth' | 'image-manifest' | 'toolchain-pin' | 'compose-variable' | 'health-probe'
    readonly operation?: Operation
})>

export type GeneratedEnvironmentResult = Readonly<{
    kind: 'complete'
    compose: string
    secretsTemplates: Readonly<Record<string, string>>
    decisions: string
    manifest: readonly GeneratedOwnedFile[]
    observations: readonly GeneratedObservationPlan[]
    replay: Readonly<{ profiles: readonly string[]; mounts: readonly string[]; route: 'generated-compose' }>
}> | Readonly<{
    kind: 'refusal'
    code: 'GENERATED_DECLARATION_INVALID' | 'GENERATED_INPUT_INVALID' | 'GENERATED_TEMPLATE_INVALID'
    reason: string
}>

export interface GeneratedComposeArtifactAuthority { readonly kind: 'generated-compose-artifact-authority' }

export type GeneratedRenderEnvelope = Readonly<{
    declaration: GeneratedEnvironmentDeclaration
    hostInputDirectories: Readonly<Record<string, string>>
    stackId: StackId
    cockpitId: string
    sourceSha256: string
    generation: string
}>

interface GeneratedComposeArtifactContract {
    readonly reference: string
    readonly source: string
    readonly sha256: string
    readonly sourceSha256: string
    readonly stackId?: StackId
    readonly cockpitId?: string
}

const issuedRenders = new WeakMap<object, GeneratedRenderEnvelope>()
const issuedComposeAuthorities = new WeakMap<object, GeneratedComposeArtifactContract>()

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) return undefined
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}

function snapshotRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === null ? value as Record<string, unknown> : undefined
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(record).sort()
    const expected = [...keys].sort()
    return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`
}

function shellOperation(operation: Operation, bounded = false): string {
    const command = `${bounded ? `timeout ${operation.timeout_seconds}s ` : ''}${operation.argv.map(shellQuote).join(' ')}`
    const shell = operation.cwd === '.' ? command : `cd ${shellQuote(operation.cwd)} && ${command}`
    return shell.replaceAll('$', () => '$$')
}

function sortedRecord(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
    return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)))
}

function literalDefault(variable: string, value: string | number): string {
    return `\${${variable}:-${value}}`
}

function imageRegistry(reference: string): string {
    const first = reference.split('/')[0]!
    return first.includes('.') || first.includes(':') || first === 'localhost' ? first : 'docker.io'
}

function safeGeneratedPath(value: string): boolean {
    return SAFE_PATH.test(value)
}

// Build inputs may be authenticated sibling checkouts beside the cockpit; owned outputs may not.
function safeSiblingInputDirectory(value: string): boolean {
    const remainder = value.replace(/^(?:\.\.\/)*/, '')
    return !/^[a-z]:/i.test(remainder) && (remainder === '..' || safeGeneratedPath(remainder))
}

function decisionValue(value: unknown): string {
    return JSON.stringify(value)
}

// A value with no provenance of its own takes its nearest enclosing declaration's; with none at
// all it was written into the configuration file itself, and the log says exactly that.
const CONFIGURATION_DECLARED = 'declared in the cockpit configuration'

function subjectProvenance(
    declaration: GeneratedEnvironmentDeclaration,
    subject: ReturnType<typeof decisionSubjects>[number],
): Readonly<{ provenance?: Provenance; inheritedFrom?: string }> {
    const service = subject.service === undefined ? undefined : declaration.services.find(({ id }) => id === subject.service)
    switch (subject.subject) {
        case 'service': return { provenance: service?.provenance }
        case 'mount':
        case 'port': return { provenance: service?.provenance, inheritedFrom: `service:${subject.service}` }
        case 'volume': return { provenance: declaration.volumes.find(({ id }) => id === subject.subjectId)?.provenance }
        case 'data-default':
        case 'data-mode': return { provenance: declaration.data?.modes.find(({ mode }) => mode === subject.subjectId)?.provenance }
        case 'restore': return { provenance: declaration.data?.restore?.provenance }
        case 'vendor': return { provenance: declaration.vendors.find(({ id }) => id === subject.subjectId)?.provenance }
    }
}

function renderDecisions(declaration: GeneratedEnvironmentDeclaration, sourceSha256: string, generation: string): string {
    const lines = [
        '# Environment decisions',
        '',
        'This file is generated from the resolved environment declaration.',
        '',
        `- Runtime declaration SHA-256: ${decisionValue(sourceSha256)}`,
        `- Generation: ${decisionValue(generation)}`,
    ]
    lines.push('', '**Service resource ceilings**', '')
    for (const service of [...declaration.services].sort((left, right) => left.id.localeCompare(right.id))) {
        lines.push(`- Resource ceilings: ${service.id}: ${service.resources ? decisionValue(service.resources) : 'not declared; runtime defaults apply'}`)
    }
    for (const subject of decisionSubjects(declaration)) {
        const entry = declaration.decisions.entries.find((candidate) => candidate.subject === subject.subject && candidate.subject_id === subject.subjectId)
        if (!entry) {
            const { provenance, inheritedFrom } = subjectProvenance(declaration, subject)
            lines.push(
                '',
                `## ${subject.subject}:${subject.subjectId}`,
                '',
                '- Status: **undecided**',
                `- Provenance: ${provenance ? decisionValue(provenance) : decisionValue(CONFIGURATION_DECLARED)}`,
                ...(inheritedFrom === undefined ? [] : [`- Provenance inherited from: ${decisionValue(inheritedFrom)}`]),
            )
            continue
        }
        const vendor = entry.subject === 'vendor' ? declaration.vendors.find((candidate) => candidate.id === entry.subject_id) : undefined
        lines.push(
            '',
            `## ${entry.subject}:${entry.subject_id}`,
            '',
            `- ID: ${decisionValue(entry.id)}`,
            `- Decided on: ${decisionValue(entry.decided_on)}`,
            `- Decision: ${decisionValue(entry.decision)}`,
            `- Rejected: ${decisionValue(entry.rejected)}`,
            `- Reason: ${decisionValue(entry.reason)}`,
            `- Provenance: ${decisionValue(entry.provenance)}`,
            ...(vendor === undefined ? [] : [
                `- Vendor posture: ${decisionValue(vendor.posture)}`,
                `- Vendor reason: ${decisionValue(vendor.reason)}`,
                `- Declaration provenance: ${decisionValue(vendor.provenance)}`,
            ]),
        )
    }
    return `${lines.join('\n')}\n`
}

function serviceEnvironment(
    declaration: GeneratedEnvironmentDeclaration,
    serviceId: string,
): { environment: Record<string, string>; normalize: readonly string[]; startup: readonly Operation[] } | undefined {
    const values = new Map<string, string>()
    const normalize = new Set<string>()
    const startup: Operation[] = []
    for (const vendor of [...declaration.vendors].sort((left, right) => left.id.localeCompare(right.id))) {
        const fragments = externalDependencyTemplateFragments(vendor)
        if (fragments.kind !== 'complete') return undefined
        const targets = new Set(fragments.runtime.map((entry) => entry.service))
        for (const entry of fragments.runtime) {
            if (entry.service === serviceId) values.set(entry.variable, entry.value)
        }
        if (targets.has(serviceId)) {
            for (const entry of fragments.nonempty) values.set(entry.variable, entry.value)
            for (const entry of [...fragments.runtime, ...fragments.nonempty]) normalize.add(entry.variable)
        }
        if (vendor.tls?.generate_at_start.service === serviceId) startup.push(vendor.tls.generate_at_start)
    }
    return { environment: Object.fromEntries([...values].sort(([left], [right]) => left.localeCompare(right))), normalize: [...normalize].sort(), startup }
}

function hostInputPath(directory: string, source: string): string {
    return directory === '.' ? source : source === '.' ? directory : `${directory}/${source}`
}

function buildContext(build: NonNullable<GeneratedEnvironmentDeclaration['services'][number]['build']>, siblingDirectory: string): Record<string, string> {
    const context = hostInputPath(siblingDirectory, build.context)
    return { context, ...(build.dockerfile === undefined ? {} : { dockerfile: build.dockerfile }) }
}

function renderCompose(declaration: GeneratedEnvironmentDeclaration, input: GeneratedEnvironmentInput, hostInputDirectories: Readonly<Record<string, string>>): string | undefined {
    const ownershipLabels = {
        'dev.b0dea.cockpit.stack-id': '${COCKPIT_STACK_ID:?cockpit runtime stack identity is unavailable}',
        'dev.b0dea.cockpit.config-sha256': input.sourceSha256,
        'dev.b0dea.cockpit.owner-id': '${COCKPIT_OWNER_ID:?cockpit runtime owner identity is unavailable}',
        'dev.b0dea.cockpit.generation-id': input.generation,
    }
    // The running stack's work is bound to these bytes, so they carry no reasons, health properties
    // or measurements: rewording one would otherwise demand a `down` before the next `up`.
    const services: Record<string, unknown> = {}
    for (const service of [...declaration.services].sort((left, right) => left.id.localeCompare(right.id))) {
        const projection = serviceEnvironment(declaration, service.id)
        if (!projection) return undefined
        const startup = [
            ...projection.normalize.map((variable) => `[ -n "$$\{${variable}:-}" ] || unset ${variable}`),
            ...projection.startup.map((operation) => shellOperation(operation, true)),
        ]
        const park = service.role === 'one-shot'
            ? '"$$@" || { status=$$?; printf "one-shot failed with status %s; parked for inspection\\n" "$$status" >&2; exec tail -f /dev/null; }'
            : 'exec "$$@"'
        const wrapper = [...startup, park].join('\n')
        const dependsOn = sortedRecord(service.dependencies.map((dependency) => [dependency.service, {
            condition: dependency.condition,
            required: true,
        }]))
        const ports = [...service.ports].sort((left, right) => left.name.localeCompare(right.name)).map((port) => {
            const fallback = input.portDefaults[port.host_variable]
            if (!Number.isInteger(fallback) || fallback < 1 || fallback > 65535) return undefined
            return {
                target: port.internal, published: literalDefault(port.host_variable, fallback), host_ip: port.host_ip, protocol: 'tcp',
            }
        })
        if (ports.some((port) => port === undefined)) return undefined
        const mounts = [...service.mounts].sort((left, right) => `${left.kind}:${left.source}:${left.target}`.localeCompare(`${right.kind}:${right.source}:${right.target}`)).map((mount) => mount.kind === 'volume'
            ? { type: 'volume', source: mount.source, target: mount.target }
            : { type: 'bind', source: hostInputPath(hostInputDirectories[service.id]!, mount.source), target: mount.target, read_only: mount.kind === 'environment-file' })
        // A pinned image knows nothing about the checkout mounted into it, so its own working
        // directory (often `/`) made a relative command such as `node server.js` miss the code. A
        // built image keeps the WORKDIR its Dockerfile declares.
        const checkoutMounts = service.mounts.filter((mount) => mount.kind === 'bind' && mount.source === '.')
        const workingDir = service.image && checkoutMounts.length === 1 ? checkoutMounts[0]!.target : undefined
        services[service.id] = {
            // The built image carries the ownership labels too, or `down` left every image it built.
            ...(service.image ? { image: service.image.reference }
                : { build: { ...buildContext(service.build!, input.siblingDirectories[service.sibling]!), labels: { ...ownershipLabels } } }),
            ...(workingDir === undefined ? {} : { working_dir: workingDir }),
            // The entrypoint execs the product command as PID 1, which gets no default signal
            // handling: a server that ignores SIGTERM held sleep and down for the whole stop grace.
            init: true,
            ...(service.resources ? { mem_limit: `${service.resources.memory_mb}m`, cpus: service.resources.cpus } : {}),
            labels: {
                ...ownershipLabels,
                'dev.b0.cockpit.generated': '1',
                'dev.b0.cockpit.generation': input.generation,
                'dev.b0.cockpit.source-sha256': input.sourceSha256,
                'dev.b0.cockpit.mounts': service.mounts.map((mount) => `${mount.kind}:${mount.source}:${mount.target}`).sort().join(','),
                'dev.b0.cockpit.profiles': [...service.profiles].sort().join(','),
            },
            ...(service.profiles.length === 0 ? {} : { profiles: [...service.profiles].sort() }),
            entrypoint: ['/bin/sh', '-eu', '-c', wrapper, '--'],
            command: [...service.command],
            ...(Object.keys(projection.environment).length === 0 ? {} : { environment: projection.environment }),
            ...(ports.length === 0 ? {} : { ports }),
            ...(!service.host_aliases?.length ? {} : { extra_hosts: sortedRecord(service.host_aliases.map(({ hostname, address }) => [hostname, address])) }),
            ...(mounts.length === 0 ? {} : { volumes: mounts }),
            ...(service.dependencies.length === 0 ? {} : { depends_on: dependsOn }),
            healthcheck: {
                test: ['CMD-SHELL', shellOperation(service.health.probe)],
                interval: `${service.health.interval_seconds}s`,
                timeout: `${service.health.timeout_seconds}s`,
                retries: service.health.retries,
                start_period: `${service.health.start_period_seconds}s`,
            },
            restart: service.role === 'one-shot' ? 'no' : 'unless-stopped',
            'x-cockpit-mount-contracts': service.mounts.map((mount) => `${mount.kind}:${mount.source}:${mount.target}:${mount.source_type ?? 'named-volume'}`).sort(),
            ...(service.image ? { 'x-cockpit-image-architectures': [...service.image.architectures].sort() } : {}),
        }
    }
    const volumes = sortedRecord(declaration.volumes.map((volume) => [volume.id, {
        labels: {
            ...ownershipLabels,
            'dev.b0.cockpit.generated': '1',
            'dev.b0.cockpit.generation': input.generation,
            'dev.b0.cockpit.purpose': volume.purpose,
        },
    }]))
    // No top-level `name`: the file is committed and shared by every checkout, while the project is
    // per stack (`composeProjectName`), and every cockpit command passes it with `--project-name`.
    return stringifyYaml({
        services: sortedRecord(Object.entries(services)),
        ...(Object.keys(volumes).length === 0 ? {} : { volumes }),
        networks: { default: { labels: ownershipLabels } },
    }, { lineWidth: 0, sortMapEntries: true })
}

function renderSecretsTemplates(declaration: GeneratedEnvironmentDeclaration, siblingDirectories: Readonly<Record<string, string>>): Readonly<Record<string, string>> | undefined {
    const files = new Map<string, Map<string, string>>()
    for (const vendor of [...declaration.vendors].sort((left, right) => left.id.localeCompare(right.id))) {
        const fragments = externalDependencyTemplateFragments(vendor)
        if (fragments.kind !== 'complete') return undefined
        const suppliers = new Set<string>()
        for (const entry of fragments.secretsTemplate) {
            const directory = siblingDirectories[entry.sibling]
            if (directory === undefined || !safeGeneratedPath(directory)) return undefined
            const path = directory === '.' ? entry.template : `${directory}/${entry.template}`
            if (!safeGeneratedPath(path)) return undefined
            suppliers.add(path)
            const values = files.get(path) ?? new Map<string, string>()
            values.set(entry.variable, entry.value)
            files.set(path, values)
        }
        for (const path of suppliers) {
            const values = files.get(path) ?? new Map<string, string>()
            for (const entry of fragments.nonempty) values.set(entry.variable, entry.value)
            files.set(path, values)
        }
    }
    return Object.freeze(Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, values]) => [
        path,
        `${[...values].sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}=${value}`).join('\n')}\n`,
    ])))
}

function observationPlans(declaration: GeneratedEnvironmentDeclaration, portDefaults: Readonly<Record<string, number>>): readonly GeneratedObservationPlan[] {
    const plans: GeneratedObservationPlan[] = []
    const boundedStartupServices = new Set(declaration.vendors.flatMap((vendor) => vendor.tls?.generate_at_start.service === undefined ? [] : [vendor.tls.generate_at_start.service]))
    const ports = declaration.services.flatMap((service) => service.ports.map((port) => Object.freeze({
        service: service.id,
        variable: port.host_variable,
        published: portDefaults[port.host_variable],
        target: port.internal,
    })))
    if (ports.length > 0) plans.push({
        id: 'compose-variables', kind: 'compose-variable', target: declaration.compose_file,
        expected: { ports: Object.freeze(ports) },
    })
    for (const service of declaration.services) {
        for (const mount of service.mounts) {
            if (mount.kind !== 'volume') plans.push({ id: `mount:${service.id}:${mount.target}`, kind: 'mount-lstat', target: mount.source, expected: { service: service.id, type: mount.source_type } })
        }
        for (const pin of service.toolchain_pins) plans.push({ id: `toolchain:${service.id}:${pin.path}`, kind: 'toolchain-pin', target: pin.path, expected: { service: service.id, pinned: pin.pinned, observed: pin.observed, action: 'diagnose-only' } })
        plans.push({ id: `health:${service.id}:property`, kind: 'health-probe', target: service.health.property, expected: { service: service.id, role: 'property', ...(service.health.tool_probe ? {} : { toolPresence: 'unchecked' }) }, operation: service.health.probe })
        if (service.health.tool_probe) plans.push({ id: `health:${service.id}:tool`, kind: 'health-probe', target: service.health.property, expected: { service: service.id, role: 'tool-availability' }, operation: service.health.tool_probe })
        // Launcher and manifest checks inspect a pinned image before start; a built service has
        // no image until the build runs, so they have nothing to inspect.
        if (!service.image) continue
        const launcherChecks = [
            ...(boundedStartupServices.has(service.id) ? ['command -v timeout >/dev/null'] : []),
            ...(service.role === 'one-shot' ? ['command -v tail >/dev/null'] : []),
        ]
        plans.push({
            id: `startup:${service.id}:launcher`, kind: 'image-startup-launcher', target: service.image.reference,
            launcher: Object.freeze({
                image: service.image.reference,
                entrypoint: '/bin/sh' as const,
                argv: Object.freeze(['-eu', '-c', launcherChecks.length === 0 ? ':' : launcherChecks.join('\n')]) as readonly [string, ...string[]],
                timeoutSeconds: 30,
            }),
            expected: {
                timeoutExecutable: boundedStartupServices.has(service.id) ? 'timeout' : null,
                parkExecutable: service.role === 'one-shot' ? 'tail' : null,
            },
        })
        plans.push({ id: `image:${service.id}:manifest`, kind: 'image-manifest', target: service.image.reference, expected: { architectures: Object.freeze([...service.image.architectures].sort()), reason: service.image.reason }, operation: service.image.manifest_probe })
        if (service.image.registry_auth_probe) plans.push({ id: `image:${service.id}:registry-auth`, kind: 'registry-auth', target: imageRegistry(service.image.reference), expected: { requirement: 'build-time-only', credentialValues: 'excluded' }, operation: service.image.registry_auth_probe })
    }
    return Object.freeze(plans.sort((left, right) => left.id.localeCompare(right.id)).map((plan) => Object.freeze({
        ...plan,
        expected: Object.freeze({ ...plan.expected }),
    })))
}

export function renderGeneratedEnvironment(input: GeneratedEnvironmentInput): GeneratedEnvironmentResult {
    const captured = snapshotGeneratedJson(input)
    const record = snapshotRecord(captured)
    const inputKeys = ['declaration', 'sourceSha256', 'generation', 'stackId', 'cockpitId', 'portDefaults', 'siblingDirectories', ...(Object.hasOwn(record ?? {}, 'browserRunner') ? ['browserRunner'] : [])]
    if (!record || !exactKeys(record, inputKeys)
        || typeof record.sourceSha256 !== 'string' || !SHA256.test(record.sourceSha256)
        || typeof record.generation !== 'string' || !SHA256.test(record.generation)
        || typeof record.stackId !== 'string' || !STACK_ID.test(record.stackId)
        || typeof record.cockpitId !== 'string' || !COCKPIT_ID.test(record.cockpitId)
        || !snapshotRecord(record.portDefaults) || !snapshotRecord(record.siblingDirectories)) {
        return Object.freeze({ kind: 'refusal', code: 'GENERATED_INPUT_INVALID', reason: 'generated environment identity or port defaults are invalid' })
    }
    const safeInput = record as unknown as GeneratedEnvironmentInput
    const parsed = GeneratedEnvironment.safeParse(safeInput.declaration)
    if (!parsed.success) return Object.freeze({ kind: 'refusal', code: 'GENERATED_DECLARATION_INVALID', reason: 'generated environment declaration is invalid' })
    const capturedDeclaration = snapshotGeneratedJson(parsed.data) as GeneratedEnvironmentDeclaration | undefined
    if (!capturedDeclaration) return Object.freeze({ kind: 'refusal', code: 'GENERATED_DECLARATION_INVALID', reason: 'generated environment declaration exceeds capture bounds' })
    let declaration: GeneratedEnvironmentDeclaration = capturedDeclaration
    let browserService: string | undefined
    if (safeInput.browserRunner) {
        const runner = GeneratedEnvironment.shape.services.element.safeParse(safeInput.browserRunner.service)
        if (!runner.success || declaration.services.some(({ id }) => id === runner.data.id)) {
            return Object.freeze({ kind: 'refusal', code: 'GENERATED_DECLARATION_INVALID', reason: 'browser runner service is invalid or duplicated' })
        }
        browserService = runner.data.id
        declaration = { ...declaration, services: [...declaration.services, runner.data] }
    }
    if (!safeGeneratedPath(declaration.compose_file)) {
        return Object.freeze({ kind: 'refusal', code: 'GENERATED_INPUT_INVALID', reason: 'generated output path is invalid' })
    }
    const hostServices = declaration.services.filter(service => service.mounts.some(mount => mount.kind !== 'volume')
        || service.toolchain_pins.length > 0)
    const invalidInput = declaration.services.find(service => service.id !== browserService
        && (service.build !== undefined || hostServices.includes(service))
        && (typeof safeInput.siblingDirectories[service.sibling] !== 'string'
            || !safeSiblingInputDirectory(safeInput.siblingDirectories[service.sibling]!)))
    if (invalidInput) {
        return Object.freeze({ kind: 'refusal', code: 'GENERATED_INPUT_INVALID',
            reason: `${invalidInput.build ? 'built' : 'generated'} service ${invalidInput.id} names sibling ${invalidInput.sibling} without a valid relative checkout directory; fix: correct its sibling dir under cockpit.siblings_root, then run npx --no cockpit sync --config <your cockpit.toml>` })
    }
    const hostInputDirectories = Object.freeze(Object.fromEntries(hostServices.map(service =>
        [service.id, service.id === browserService ? '.' : safeInput.siblingDirectories[service.sibling]!])))
    const compose = renderCompose(declaration, safeInput, hostInputDirectories)
    const secretsTemplates = renderSecretsTemplates(declaration, safeInput.siblingDirectories)
    if (compose === undefined || secretsTemplates === undefined) return Object.freeze({ kind: 'refusal', code: 'GENERATED_TEMPLATE_INVALID', reason: 'external dependency template projection is invalid' })
    const decisions = renderDecisions(declaration, safeInput.sourceSha256, safeInput.generation)
    const fileValues: [string, string][] = [[declaration.compose_file, compose], [DECISIONS_PATH, decisions], ...Object.entries(secretsTemplates)]
    if (new Set(fileValues.map(([path]) => path)).size !== fileValues.length || fileValues.some(([path]) => !safeGeneratedPath(path))) {
        return Object.freeze({ kind: 'refusal', code: 'GENERATED_INPUT_INVALID', reason: 'generated output ownership is duplicated or invalid' })
    }
    const manifest = Object.freeze([...fileValues].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => Object.freeze({
        path, bytes, sha256: sha256(bytes), sourceSha256: safeInput.sourceSha256, generation: safeInput.generation, ownership: 'whole-file' as const,
    })))
    const profiles = Object.freeze([...new Set(declaration.services.flatMap((service) => service.profiles))].sort())
    const mounts = Object.freeze(declaration.services.flatMap((service) => service.mounts.map((mount) => `${service.id}:${mount.kind}:${mount.source}:${mount.target}`)).sort())
    const result = Object.freeze({
        kind: 'complete', compose, secretsTemplates, decisions, manifest,
        observations: observationPlans(declaration, safeInput.portDefaults),
        replay: Object.freeze({ profiles, mounts, route: 'generated-compose' as const }),
    })
    issuedRenders.set(result, Object.freeze({
        declaration, hostInputDirectories, stackId: safeInput.stackId as StackId, cockpitId: safeInput.cockpitId,
        sourceSha256: safeInput.sourceSha256, generation: safeInput.generation,
    }))
    return result
}


export function authenticateGeneratedRender(rendered: GeneratedEnvironmentResult): GeneratedRenderEnvelope | undefined {
    if (rendered === null || typeof rendered !== 'object' || isProxy(rendered)) return undefined
    return issuedRenders.get(rendered)
}

function composeArtifactContract(value: unknown): GeneratedComposeArtifactContract | undefined {
    const input = ownRecord(value)
    if (!input || !exactKeys(input, ['reference', 'sha256', 'source', 'sourceSha256'])
        || typeof input.reference !== 'string' || input.reference.length === 0 || input.reference.includes('\0')
        || typeof input.source !== 'string' || Buffer.byteLength(input.source) > MAX_SOURCE_BYTES
        || typeof input.sha256 !== 'string' || !SHA256.test(input.sha256)
        || typeof input.sourceSha256 !== 'string' || !SHA256.test(input.sourceSha256)
        || sha256(input.source) !== input.sha256) return undefined
    return Object.freeze({
        reference: input.reference,
        source: input.source,
        sha256: input.sha256,
        sourceSha256: input.sourceSha256,
    })
}

export function projectGeneratedComposeArtifactAuthority(
    rendered: GeneratedEnvironmentResult,
): GeneratedComposeArtifactAuthority | undefined {
    const renderAuthority = authenticateGeneratedRender(rendered)
    if (!renderAuthority || rendered.kind !== 'complete') return undefined
    const compose = rendered.manifest.find(({ path }) => path === renderAuthority.declaration.compose_file)
    if (!compose || compose.bytes !== rendered.compose) return undefined
    const contract = composeArtifactContract({
        reference: compose.path,
        source: compose.bytes,
        sha256: compose.sha256,
        sourceSha256: renderAuthority.sourceSha256,
    })
    if (!contract) return undefined
    const authority = Object.freeze({ kind: 'generated-compose-artifact-authority' as const })
    issuedComposeAuthorities.set(authority, Object.freeze({ ...contract,
        stackId: renderAuthority.stackId, cockpitId: renderAuthority.cockpitId }))
    return authority
}

export function authenticateGeneratedComposeArtifact(
    authority: GeneratedComposeArtifactAuthority,
    input: GeneratedComposeArtifactContract,
): boolean {
    if (authority === null || typeof authority !== 'object' || isProxy(authority)) return false
    const expected = issuedComposeAuthorities.get(authority)
    const captured = composeArtifactContract(input)
    return expected !== undefined && captured !== undefined
        && captured.reference === expected.reference && captured.source === expected.source
        && captured.sha256 === expected.sha256 && captured.sourceSha256 === expected.sourceSha256
}

export function projectGeneratedComposeRuntimeIdentity(
    authority: GeneratedComposeArtifactAuthority,
): Readonly<{ stackId: StackId; cockpitId: string }> | undefined {
    if (authority === null || typeof authority !== 'object' || isProxy(authority)) return undefined
    const expected = issuedComposeAuthorities.get(authority)
    return expected?.stackId && expected.cockpitId
        ? Object.freeze({ stackId: expected.stackId, cockpitId: expected.cockpitId }) : undefined
}
