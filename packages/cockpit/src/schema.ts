import { isIP } from 'node:net'
import { z } from 'zod'
import { parseDocument } from 'yaml'
import { browserProxyAuthorityMatches } from './browser/proxy.js'
import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'
import { GUARD_HOST_LIMITS, GUARD_HOST_PATTERN, normalizeGuardHost } from './guards/host.js'
import { ADOPTABLE_SURFACE_PATHS, ADOPTED_SURFACE_ROOT, SURFACE_BUNDLE_FORMATS, SURFACE_FEATURES, SURFACE_TARGETS, surfaceSourcesMatchFeature } from './surfaces/contract.js'
import { GUARD_SURFACE_TARGETS } from './surfaces/harness-registry.js'

export const mechanism = {
    id: 'configuration-schema',
    module: 'packages/cockpit/src/schema.ts',
    exports: [
        'Mount',
        'Acquire',
        'AddressingPosture',
        'AuthPosture',
        'Toolchain',
        'Gate',
        'EnvironmentFile',
        'MachineFloor',
        'ResettableVolumeId',
        'GeneratedHostPath',
        'parseBrowserNetworkExposure',
        'SafeUrlPath',
        'EntrypointDerivative',
        'InstallPolicy',
        'GuardCommandArgv',
        'GUARD_COMMAND_WORD_PATTERN',
        'RuntimeMeasurement',
        'ContainerPath',
        'EnvironmentName',
        'Provenance',
        'GeneratedService',
        'GeneratedEnvironment',
        'decisionSubjects',
        'DataMode',
        'VendorPosture',
        'Environment',
        'Sibling',
        'Ports',
        'Guards',
        'Mcp',
        'Workorders',
        'Browser',
        'Testing',
        'CockpitMeta',
        'SurfaceSource',
        'SurfaceOverrideReference',
        'SurfaceDeclaration',
        'SurfaceOverlay',
        'SurfaceAdoption',
        'CustomHarnessCapability',
        'CustomHarness',
        'Surfaces',
        'CockpitConfig',
        'STRUCTURED_INPUT_ENTRY_LIMIT',
        'OPERATOR_GATE_RISK_PATTERN',
        'LOCAL_ENDPOINT_URL_PATTERN',
        'requiresOperatorGate',
        'configurationDefaults',
        'mounted',
    ],
} as const

export const STRUCTURED_INPUT_ENTRY_LIMIT = 4_096

// A sibling is described on two axes, and keeping them separate is the point.
//
// `mount` is how the STACK USES a checkout: bind-mounted on every bring-up, mounted only
// under a compose profile, driven by a task and never a service, or read but never mounted.
// `acquire` is how the checkout REACHES THE DISK: cloned by setup, cloned by a human, or
// not a repository at all.
//
// Neither derives from the other. A storefront theme can be task-driven yet auto-cloned; a
// booking companion can be profile-gated yet cloned by hand. Collapsing them onto one field
// produces the failure this schema exists to prevent: a preflight that reports healthy
// while the stack mounts the wrong thing, or nothing.
export type Mount = 'always' | 'host' | 'none' | `profile:${string}`
// Zod cannot reflect a regex in a string type; successful parses satisfy this narrower output.
export const Mount = z
    .enum(['always', 'host', 'none'])
    .or(z.string().regex(/^profile:[a-z0-9-]+$/, 'expected `profile:<name>`')) as z.ZodType<Mount>

// `auto` clones on setup, `manual` expects a human (setup wires the extra remotes), `none`
// is not a repository at all — a path to local data, referenced and never cloned. A row with
// acquire `none` has no remote, which the refinement below enforces.
export const Acquire = z.enum(['auto', 'manual', 'none'])

export const AddressingPosture = z.enum(['hostname', 'port'])
export const AuthPosture = z.enum(['real', 'bypassed'])

// What installs and tests a sibling. The cockpit owns the environment; the toolchain owns
// the commands, and they are delegated rather than reimplemented. `none` is a real answer —
// a directory of data has no install step and must not acquire one by default.
export const Toolchain = z.enum(['node', 'python', 'ruby', 'go', 'rust', 'dotnet', 'none'])

const SafeRelativePath = z
    .string()
    .regex(
        /^(?!\/)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?:[^/\x00-\x1f\x7f]+\/)*[^/\x00-\x1f\x7f]+$/,
        'expected a confined relative path without dot segments or backslashes',
    )

const SurfacePath = SafeRelativePath.and(z.string().max(4096).regex(
    /^(?!.*(?:^|\/)(?:\.git|internal|node_modules)(?:\/|$)).+$/,
    'surface paths cannot enter private or machine-owned directories',
))

const LocalComposePath = SafeRelativePath.regex(/^[^:]+$/, 'expected a local compose file path')
export const SafeUrlPath = z
    .string()
    .regex(
        /^\/(?!\/)(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*[%\\?#\x00-\x20\x7f]).*$/,
        'expected an absolute URL path without escapes, dot segments, controls, backslashes, query, or fragment',
    )

export const EnvironmentFile = z
    .object({
        template: SafeRelativePath,
        instance: SafeRelativePath,
    })
    .strict()
    .refine((file) => file.template !== file.instance, {
        message: 'template and instance must name different files',
        path: ['instance'],
    })

export const MachineFloor = z
    .object({
        runtime_memory_mb: z.number().int().positive(),
        runtime_cpus: z.number().positive(),
        free_disk_mb: z.number().int().positive(),
        cold_start_seconds: z.number().int().positive(),
    })
    .strict()

export const ResettableVolumeId = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/)
export const GeneratedHostPath = SafeRelativePath

export function parseBrowserNetworkExposure(
    value: string | undefined,
    reason: string | undefined,
): Readonly<{ value: string; reason?: string }> {
    const exposure = value ?? '<loopback>'
    const rules = exposure.split(',')
    const validRule = (candidate: string) => {
        if (candidate === '<loopback>' || candidate === '*') return true
        const ipv6 = /^\[([0-9a-f:]+)\](?::([1-9][0-9]{0,4}))?$/.exec(candidate)
        if (ipv6) return isIP(ipv6[1]!) === 6 && (!ipv6[2] || Number(ipv6[2]) <= 65_535)
        const authority = /^([^:]+)(?::([1-9][0-9]{0,4}))?$/.exec(candidate)
        if (!authority || authority[2] && Number(authority[2]) > 65_535) return false
        const wildcard = authority[1]!.startsWith('*.')
        const hostname = wildcard ? authority[1]!.slice(2) : authority[1]!
        if (hostname.length > 253 || wildcard && isIP(hostname) !== 0) return false
        return isIP(hostname) === 4
            || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
    }
    if (Buffer.byteLength(exposure) > 512 || rules.length === 0 || rules.length > 32
        || new Set(rules).size !== rules.length || rules.some((rule) => !rule || rule !== rule.trim() || !validRule(rule))) {
        throw new TypeError('browser network exposure must contain bounded Playwright hostname, IP, wildcard or loopback rules')
    }
    if (exposure === '<loopback>') {
        if (reason !== undefined) throw new TypeError('browser network exposure reason is only valid for a wider decision')
        return Object.freeze({ value: exposure })
    }
    if (typeof reason !== 'string' || reason !== reason.trim() || reason.length === 0 || Buffer.byteLength(reason) > 512
        || /[\x00-\x1f\x7f]/.test(reason)) throw new TypeError('wider browser network exposure requires a bounded explicit reason')
    return Object.freeze({ value: exposure, reason })
}

export const EntrypointDerivative = z
    .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        kind: z.enum(ENTRYPOINT_KINDS),
        port: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        path: SafeUrlPath,
    })
    .strict()

const CommandArgv = z.array(z.string().min(1)).min(1)

// Unicode mode counts scalar values, excluding lone surrogate code units before UTF-8 encoding.
export const GUARD_COMMAND_WORD_PATTERN = '^[^\\x00-\\x1f\\x7f-\\x9f\\uD800-\\uDFFF]{1,128}(?![\\s\\S])'
export const GuardCommandArgv = z.array(z.string().regex(new RegExp(GUARD_COMMAND_WORD_PATTERN, 'u'))).min(1).max(32)

export const InstallPolicy = z
    .object({
        toolchain: Toolchain.exclude(['none']),
        volume: ResettableVolumeId,
        lockfile: SafeRelativePath,
        install: CommandArgv,
        load_probe: CommandArgv,
        build: GuardCommandArgv.optional(),
        test: GuardCommandArgv.optional(),
    })
    .strict()

const RuntimeMeasurementBase = {
    runtime: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    compose_floor: z.string().regex(/^\d+\.\d+\.\d+$/),
    measured_on: z.string().date(),
} as const

export const RuntimeMeasurement = z.union([
    z
        .object({
            ...RuntimeMeasurementBase,
            candidate: z.literal('passed'),
            broken_control: z.literal('rejected'),
            status: z.literal('supported'),
        })
        .strict(),
    z
        .object({
            ...RuntimeMeasurementBase,
            candidate: z.literal('failed'),
            broken_control: z.enum(['rejected', 'accepted']),
            status: z.literal('unavailable'),
        })
        .strict(),
    z
        .object({
            ...RuntimeMeasurementBase,
            candidate: z.literal('passed'),
            broken_control: z.literal('accepted'),
            status: z.literal('unavailable'),
        })
        .strict(),
    z
        .object({
            runtime: RuntimeMeasurementBase.runtime,
            recorded_on: z.string().date(),
            status: z.literal('unmeasured'),
        })
        .strict(),
])

function hasDuplicate(values: readonly string[]): boolean {
    return new Set(values).size !== values.length
}

const PostureRequirement = z.object({
    requirement: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
    addressing: AddressingPosture.optional(),
    authentication: AuthPosture.optional(),
}).strict().refine((requirement) => requirement.addressing !== undefined || requirement.authentication !== undefined, {
    message: 'posture requirement must tag addressing or authentication',
})

const DeclarationId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(128)
const DeclarationReason = z.string().min(1).max(4096).regex(/\S/)
const BoundedArgv = z.array(z.string().min(1).max(8192).regex(/^[^\x00]+$/)).min(1).max(256)
export const ContainerPath = z.string().max(4096).regex(/^\/(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[\\\x00-\x1f\x7f])[^:]+$/)
export const EnvironmentName = z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(128)
export const LOCAL_ENDPOINT_URL_PATTERN = String.raw`^https?://[a-z0-9][a-z0-9-]*(?::(?:0|[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?(?:/[^\s?#]*)?$`
const LOCAL_ENDPOINT_URL_RE = new RegExp(LOCAL_ENDPOINT_URL_PATTERN)
const LocalEndpointUrl = z.string().max(4096).regex(LOCAL_ENDPOINT_URL_RE)
// Where a declared value came from. A date records when its source was looked at, so it is
// required wherever the source lies outside this configuration. The one exception is a value
// declared by the configuration file itself, which the loader checks by path because the
// schema cannot see the file name.
export const Provenance = z.object({
    source: SafeRelativePath.max(4096),
    observed_on: z.string().date().optional(),
    kind: z.enum(['declared', 'measured', 'inferred']),
    reason: DeclarationReason,
    confirmed: z.boolean().optional(),
}).strict().refine((value) => value.kind !== 'inferred' || value.confirmed === true, {
    path: ['confirmed'], message: 'inferred declarations require explicit confirmation',
}).refine((value) => value.kind === 'declared' || value.observed_on !== undefined, {
    path: ['observed_on'], message: 'measured and inferred provenance require observed_on',
})

const OverlayOperation = z.object({
    location: z.enum(['host', 'in-stack']),
    service: DeclarationId.optional(),
    cwd: z.union([z.literal('.'), SafeRelativePath.max(4096)]),
    argv: BoundedArgv,
    timeout_seconds: z.number().int().min(1).max(3600),
    // Absent means the nearest enclosing declaration's provenance applies.
    provenance: Provenance.optional(),
}).strict().refine((value) => value.location === 'in-stack' ? value.service !== undefined : value.service === undefined, {
    path: ['service'], message: 'only in-stack operations require a service',
})

const GeneratedHostAlias = z.object({
    hostname: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/),
    address: z.union([z.ipv4(), z.ipv6()]),
}).strict()

const HealthMeasurement = z.object({ duration_seconds: z.number().positive().max(3600), provenance: Provenance }).strict()

export const GeneratedService = z.object({
    id: DeclarationId,
    sibling: DeclarationId,
    role: z.enum(['service', 'one-shot']).default('service'),
    one_shot_failure: z.literal('park').optional(),
    profiles: z.array(DeclarationId).max(64).default([]),
    resources: z.object({
        memory_mb: z.number().int().min(6).max(Math.floor(Number.MAX_SAFE_INTEGER / 1_048_576)),
        // Bound the default 100 ms CPU quota within its signed 64-bit calculation.
        cpus: z.number().min(0.01).max(Number(((1n << 63n) - 1n) / 100_000_000_000_000n)),
        provenance: Provenance,
    }).strict().optional(),
    command: BoundedArgv,
    // Exactly one of `image` and `build` (checked with the environment). The manifest probe
    // stays required on an image: it is what verifies the declared architectures exist.
    image: z.object({
        reference: z.string().max(4096).regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
        reason: DeclarationReason,
        architectures: z.array(z.enum(['amd64', 'arm64'])).min(1).max(2),
        manifest_probe: OverlayOperation,
        registry_auth_probe: OverlayOperation.optional(),
        provenance: Provenance.optional(),
    }).strict().optional(),
    // Built from the service's sibling checkout. Both paths are confined: `context` below the
    // sibling, `dockerfile` below the context, so a build can never reach outside the checkout.
    build: z.object({
        context: z.union([z.literal('.'), SafeRelativePath.max(4096)]),
        dockerfile: SafeRelativePath.max(4096).optional(),
    }).strict().optional(),
    ports: z.array(z.object({ name: DeclarationId, host_variable: EnvironmentName, internal: z.number().int().min(1).max(65535), host_ip: z.enum(['127.0.0.1', '::1', '0.0.0.0', '::']).optional() }).strict()).max(256).default([]),
    host_aliases: z.array(GeneratedHostAlias).max(64).refine((aliases) => !hasDuplicate(aliases.map(({ hostname }) => hostname)), {
        message: 'generated service host aliases must name unique hostnames',
    }).optional(),
    // Host inputs belong to the service sibling; named volumes retain their declared identities.
    mounts: z.array(z.object({ kind: z.enum(['bind', 'volume', 'environment-file']), source: z.union([z.literal('.'), SafeRelativePath.max(4096)]), target: ContainerPath, source_type: z.enum(['file', 'directory']).optional() }).strict().refine((mount) => mount.kind === 'volume' ? mount.source_type === undefined && mount.source !== '.' : mount.kind === 'environment-file' ? mount.source_type === 'file' : mount.source_type !== undefined, { path: ['source_type'], message: 'bind sources require their expected type and volume sources use declared identities' })).max(256).default([]),
    dependencies: z.array(z.object({ service: DeclarationId, condition: z.enum(['service_started', 'service_healthy', 'service_completed_successfully']), reason: DeclarationReason }).strict()).max(256).default([]),
    health: z.object({
        // Without a tool probe a failing property probe cannot say whether the product or the
        // probe's own tool is missing; failure text names that gap instead of guessing.
        property: DeclarationReason, probe: OverlayOperation, tool_probe: OverlayOperation.optional(),
        interval_seconds: z.number().int().min(1).max(3600),
        timeout_seconds: z.number().int().min(1).max(3600),
        retries: z.number().int().min(1).max(100),
        start_period_seconds: z.number().int().min(1).max(3600),
        measurement: HealthMeasurement.optional(),
    }).strict().refine((health) => health.measurement === undefined || health.start_period_seconds >= health.measurement.duration_seconds, {
        path: ['start_period_seconds'], message: 'start period is shorter than its measurement',
    }),
    // Pin files are read from this service sibling, including services without bind mounts.
    toolchain_pins: z.array(z.object({ path: SafeRelativePath, pinned: z.string().min(1).max(256), observed: z.string().min(1).max(256), provenance: Provenance }).strict()).max(32).default([]),
    // Absent means the value is declared by the configuration file itself.
    provenance: Provenance.optional(),
}).strict()

export const DataMode = z.enum(['empty', 'seeded', 'restored'])
export const VendorPosture = z.enum(['bypassed', 'stubbed', 'substituted', 'vendor-sandbox', 'record-replay', 'absent-and-gated'])

const DataOperation = z.object({
    id: DeclarationId,
    kind: z.enum(['schema', 'sweep', 'fixtures', 'restore', 'rewrite']),
    operation: OverlayOperation,
    prerequisites: z.array(OverlayOperation).max(64),
    after: z.array(DeclarationId).max(256),
    fresh_volume_only: z.boolean(),
    // Absent means the enclosing data mode's provenance applies.
    provenance: Provenance.optional(),
}).strict()

const VendorDeclaration = z.object({
    id: DeclarationId, posture: VendorPosture, reason: DeclarationReason, provenance: Provenance,
    endpoints: z.array(z.object({
        variable: EnvironmentName, sink: LocalEndpointUrl, runtime_service: DeclarationId,
        supplier: z.object({ sibling: DeclarationId, template: SafeRelativePath }).strict(),
    }).strict()).min(1).max(256),
    nonempty_variables: z.array(EnvironmentName).min(1).max(256).optional(),
    egress_guard: z.object({
        flag: EnvironmentName,
        enabled_value: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
        local_service: DeclarationId,
    }).strict().optional(),
    loader_probe: OverlayOperation, route_probe: OverlayOperation, egress_probe: OverlayOperation,
    normalize_empty: z.literal(true),
    placeholder: z.string().max(256).regex(/^cockpit:absent:[a-z0-9-]+$/),
    shadow_files: z.array(z.object({ sibling: DeclarationId, instance: SafeRelativePath, probe: OverlayOperation }).strict()).max(64).optional(),
    expiry: z.object({ expires_on: z.string().date(), reason: DeclarationReason, probe: OverlayOperation }).strict().optional(),
    callback_reachability: z.object({ reachable: z.boolean(), alternative: DeclarationReason, reason: DeclarationReason }).strict(),
    callback: z.object({
        feature_flag: EnvironmentName,
        enable: OverlayOperation,
        timestamp_source: OverlayOperation,
        fresh_window_seconds: z.number().int().min(1).max(3600),
        fixture: z.object({ path: SafeRelativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/), immutable_raw_bytes: z.literal(true) }).strict(),
        sign: OverlayOperation, dispatch: OverlayOperation,
        order: z.tuple([z.literal('enable'), z.literal('timestamp'), z.literal('sign'), z.literal('dispatch')]),
        verifier_source: SafeRelativePath,
        tamper_probe: OverlayOperation,
    }).strict().optional(),
    tls: z.object({ generate_at_start: OverlayOperation, append_trust_probe: OverlayOperation, hostname_probe: OverlayOperation, verification: z.literal('required') }).strict().optional(),
    stub: z.object({ validates: z.array(DeclarationReason).min(1).max(256), rejection_probe: OverlayOperation, outage_probe: OverlayOperation }).strict().optional(),
}).strict()

const GeneratedVolumes = z.array(z.object({
    id: DeclarationId, purpose: z.enum(['dependencies', 'product-data']),
    install_policy: ResettableVolumeId.optional(), target: ContainerPath, provenance: Provenance,
}).strict()).max(256)

const DECISIONS_PATH = 'docs/cockpit/environment-decisions.md'
const DECISION_SUBJECTS = ['service', 'volume', 'data-default', 'data-mode', 'restore', 'mount', 'port', 'vendor'] as const
const DecisionEntries = z.array(z.object({
    id: DeclarationId, subject: z.enum(DECISION_SUBJECTS),
    subject_id: z.string().min(1).max(4096),
    decided_on: z.string().date(), decision: DeclarationReason, rejected: z.array(DeclarationReason).min(1).max(64),
    reason: DeclarationReason, reviewer: z.literal('consumer-maintainer'), provenance: Provenance,
}).strict()).max(512)

export const GeneratedEnvironment = z.object({
    compose_file: SafeRelativePath.max(4096),
    services: z.array(GeneratedService).min(1).max(256),
    volumes: GeneratedVolumes.default([]),
    // Absent means the stack has no product data step: `up` and `reset` skip it.
    data: z.object({
        volume: DeclarationId,
        default_mode: DataMode,
        modes: z.array(z.object({ mode: DataMode, operations: z.array(DataOperation).min(1).max(256), probes: z.array(OverlayOperation).min(1).max(64), constraints_and_indexes: z.literal(true), provenance: Provenance }).strict()).min(1).max(3),
        fixtures: z.object({
            writer: z.literal('product-models'), stable_key: DeclarationReason, random_seed: z.string().min(1).max(256).optional(),
            sweep_scope: DeclarationReason, persona_source: SafeRelativePath, identity_owner: z.enum(['product', 'identity-provider']),
            persona_outputs: z.array(z.object({ path: SafeRelativePath, format: z.enum(['json', 'typescript']), reason: DeclarationReason }).strict()).max(64),
            volume_tag: DeclarationId, default_small: z.literal(true), pagination_warning: DeclarationReason, provenance: Provenance,
            volume_operations: z.array(OverlayOperation).min(1).max(256), volume_probes: z.array(OverlayOperation).min(1).max(64),
        }).strict().optional(),
        restore: z.object({
            rewrites: z.array(z.object({ category: DeclarationId, operation: OverlayOperation, reason: DeclarationReason }).strict()).max(256),
            untouched: z.array(DeclarationReason).min(1).max(256), provenance: Provenance,
        }).strict().optional(),
    }).strict().optional(),
    vendors: z.array(VendorDeclaration).max(256).default([]),
    // A structural subject without an entry is rendered as undecided rather than refused, so a
    // small stack does not have to invent a decision record to load.
    decisions: z.object({
        path: z.literal(DECISIONS_PATH).default(DECISIONS_PATH), ownership: z.literal('whole-file').default('whole-file'),
        entries: DecisionEntries.default([]),
    }).strict().prefault({}),
}).strict().superRefine((declaration, ctx) => {
    const unique = (values: readonly string[], path: (string | number)[]) => {
        if (hasDuplicate(values)) ctx.addIssue({ code: 'custom', path, message: 'declaration contains duplicate identities' })
    }
    const serviceIds = new Set(declaration.services.map((service) => service.id))
    const volumeIds = new Set(declaration.volumes.map((volume) => volume.id))
    unique([...declaration.services.map((service) => service.id)], ['services'])
    unique([...declaration.volumes.map((volume) => volume.id)], ['volumes'])
    unique(declaration.vendors.map((vendor) => vendor.id), ['vendors'])
    unique(declaration.decisions.entries.map((entry) => entry.id), ['decisions', 'entries'])
    unique(declaration.decisions.entries.map((entry) => `${entry.subject}:${entry.subject_id}`), ['decisions', 'entries'])
    unique(declaration.services.flatMap((service) => service.ports.map((port) => port.host_variable)), ['services', 'ports'])
    unique(declaration.vendors.flatMap((vendor) => [
        ...vendor.endpoints.map((endpoint) => endpoint.variable),
        ...(vendor.nonempty_variables ?? []),
        ...(vendor.egress_guard ? [vendor.egress_guard.flag] : []),
    ]), ['vendors'])
    const checkOperation = (operation: z.infer<typeof OverlayOperation>, path: (string | number)[]) => {
        if (operation.service !== undefined && !serviceIds.has(operation.service)) ctx.addIssue({ code: 'custom', path, message: 'operation references an undeclared service' })
    }
    for (const [index, service] of declaration.services.entries()) {
        const path = ['services', index]
        unique(service.profiles, [...path, 'profiles'])
        if ((service.image === undefined) === (service.build === undefined)) ctx.addIssue({ code: 'custom', path: [...path, 'image'], message: 'a generated service declares exactly one of image or build' })
        if (service.image) unique(service.image.architectures, [...path, 'image', 'architectures'])
        unique(service.ports.map((port) => port.name), [...path, 'ports'])
        unique(service.mounts.map((mount) => mount.target), [...path, 'mounts'])
        unique(service.dependencies.map((dependency) => dependency.service), [...path, 'dependencies'])
        if ((service.role === 'one-shot') !== (service.one_shot_failure === 'park')) ctx.addIssue({ code: 'custom', path: [...path, 'one_shot_failure'], message: 'only one-shot services require parked failure' })
        for (const dependency of service.dependencies) {
            if (!serviceIds.has(dependency.service) || dependency.service === service.id) ctx.addIssue({ code: 'custom', path: [...path, 'dependencies'], message: 'dependency must name another declared service' })
        }
        for (const mount of service.mounts) {
            if (mount.kind === 'volume' && !volumeIds.has(mount.source)) ctx.addIssue({ code: 'custom', path: [...path, 'mounts'], message: 'mount references an undeclared volume' })
        }
        for (const probe of [service.health.probe, ...(service.health.tool_probe ? [service.health.tool_probe] : [])]) {
            if (probe.location !== 'in-stack' || probe.service !== service.id) ctx.addIssue({ code: 'custom', path: [...path, 'health'], message: 'health probes must run in the image they measure' })
        }
        for (const [name, operation] of Object.entries({ manifest_probe: service.image?.manifest_probe, registry_auth_probe: service.image?.registry_auth_probe, health_probe: service.health.probe, health_tool_probe: service.health.tool_probe })) {
            if (operation) checkOperation(operation, [...path, name])
        }
    }
    const dependencyGraph = new Map(declaration.services.map((service) => [service.id, service.dependencies.map((dependency) => dependency.service)]))
    const pending = new Set(dependencyGraph.keys())
    while (pending.size > 0) {
        const ready = [...pending].filter((id) => dependencyGraph.get(id)!.every((dependency) => !pending.has(dependency)))
        if (ready.length === 0) {
            ctx.addIssue({ code: 'custom', path: ['services'], message: 'service dependencies contain a cycle' })
            break
        }
        ready.forEach((id) => pending.delete(id))
    }
    for (const [index, volume] of declaration.volumes.entries()) {
        if ((volume.purpose === 'dependencies') !== (volume.install_policy !== undefined)) ctx.addIssue({ code: 'custom', path: ['volumes', index, 'install_policy'], message: 'only dependency volumes require an install policy' })
        if (volume.purpose === 'dependencies') {
            if (volume.install_policy !== volume.id) ctx.addIssue({ code: 'custom', path: ['volumes', index, 'install_policy'], message: 'dependency volume and install policy identities must match' })
            const mounts = declaration.services.flatMap((service) => service.mounts).filter((mount) => mount.kind === 'volume' && mount.source === volume.id)
            if (mounts.length === 0 || mounts.some((mount) => mount.target !== volume.target)) ctx.addIssue({ code: 'custom', path: ['volumes', index, 'target'], message: 'dependency volume requires a matching service mount target' })
        }
    }
    const data = declaration.data
    if (data) {
        unique(data.modes.map((mode) => mode.mode), ['data', 'modes'])
        if (!declaration.volumes.some((volume) => volume.id === data.volume && volume.purpose === 'product-data')) ctx.addIssue({ code: 'custom', path: ['data', 'volume'], message: 'data requires a declared product-data volume' })
        if (!data.modes.some(({ mode }) => mode === data.default_mode)) ctx.addIssue({ code: 'custom', path: ['data', 'default_mode'], message: 'the default data mode must be one of the declared modes' })
        if (data.modes.some(({ mode }) => mode === 'seeded') && !data.fixtures) ctx.addIssue({ code: 'custom', path: ['data', 'fixtures'], message: 'a seeded data mode requires its fixtures declaration' })
        // Restore rewrites run only in the restored mode; without it they would parse and do nothing.
        if (data.modes.some(({ mode }) => mode === 'restored') !== (data.restore !== undefined)) ctx.addIssue({ code: 'custom', path: ['data', 'restore'], message: 'a restore declaration is required by, and only by, a restored data mode' })
        if (data.fixtures) unique(data.fixtures.persona_outputs.map((output) => output.path), ['data', 'fixtures', 'persona_outputs'])
    }
    for (const [index, mode] of (data?.modes ?? []).entries()) {
        const ids = new Set(mode.operations.map((step) => step.id))
        unique(mode.operations.map((step) => step.id), ['data', 'modes', index, 'operations'])
        const completed = new Set<string>()
        for (const [stepIndex, step] of mode.operations.entries()) {
            const path = ['data', 'modes', index, 'operations', stepIndex]
            unique(step.after, [...path, 'after'])
            if (step.after.some((id) => !ids.has(id) || !completed.has(id))) ctx.addIssue({ code: 'custom', path: [...path, 'after'], message: 'ordering must reference earlier declared operations' })
            checkOperation(step.operation, [...path, 'operation'])
            step.prerequisites.forEach((operation, i) => checkOperation(operation, [...path, 'prerequisites', i]))
            completed.add(step.id)
        }
        const kinds = new Set(mode.operations.map((operation) => operation.kind))
        if (!kinds.has('schema') || (mode.mode === 'empty' && [...kinds].some((kind) => kind !== 'schema')) || (mode.mode === 'seeded' && (!kinds.has('sweep') || !kinds.has('fixtures') || kinds.has('restore'))) || (mode.mode === 'restored' && !kinds.has('restore'))) ctx.addIssue({ code: 'custom', path: ['data', 'modes', index, 'operations'], message: 'data mode lacks its declared schema, seed or restore operations' })
        mode.probes.forEach((operation, i) => checkOperation(operation, ['data', 'modes', index, 'probes', i]))
    }
    data?.restore?.rewrites.forEach((rewrite, i) => checkOperation(rewrite.operation, ['data', 'restore', 'rewrites', i]))
    data?.fixtures?.volume_operations.forEach((operation, i) => checkOperation(operation, ['data', 'fixtures', 'volume_operations', i]))
    data?.fixtures?.volume_probes.forEach((operation, i) => checkOperation(operation, ['data', 'fixtures', 'volume_probes', i]))
    for (const [index, vendor] of declaration.vendors.entries()) {
        const path = ['vendors', index]
        unique(vendor.endpoints.map((endpoint) => endpoint.variable), [...path, 'endpoints'])
        if (vendor.egress_guard && !serviceIds.has(vendor.egress_guard.local_service)) ctx.addIssue({ code: 'custom', path: [...path, 'egress_guard', 'local_service'], message: 'egress guard references an undeclared service' })
        if (vendor.posture === 'vendor-sandbox' && vendor.expiry === undefined) ctx.addIssue({ code: 'custom', path: [...path, 'expiry'], message: 'vendor-sandbox requires an expiry clock' })
        if (vendor.posture === 'stubbed' && vendor.stub === undefined) ctx.addIssue({ code: 'custom', path: [...path, 'stub'], message: 'stubbed posture requires rejection and outage probes' })
        for (const endpoint of vendor.endpoints) {
            if (!URL.canParse(endpoint.sink)) continue
            const url = new URL(endpoint.sink)
            if (!serviceIds.has(endpoint.runtime_service) || !['http:', 'https:'].includes(url.protocol) || url.hostname !== endpoint.runtime_service || url.username || url.password || url.search || url.hash) ctx.addIssue({ code: 'custom', path: [...path, 'endpoints'], message: 'endpoint must name its declared local sink without credentials, query or fragments' })
        }
        for (const [name, operation] of Object.entries({ loader_probe: vendor.loader_probe, route_probe: vendor.route_probe, egress_probe: vendor.egress_probe, expiry_probe: vendor.expiry?.probe, rejection_probe: vendor.stub?.rejection_probe, outage_probe: vendor.stub?.outage_probe, enable: vendor.callback?.enable, timestamp_source: vendor.callback?.timestamp_source, sign: vendor.callback?.sign, dispatch: vendor.callback?.dispatch, tamper_probe: vendor.callback?.tamper_probe, generate_at_start: vendor.tls?.generate_at_start, append_trust_probe: vendor.tls?.append_trust_probe, hostname_probe: vendor.tls?.hostname_probe })) {
            if (operation) checkOperation(operation, [...path, name])
        }
        vendor.shadow_files?.forEach((file, i) => checkOperation(file.probe, [...path, 'shadow_files', i]))
    }
    const subjects = new Set(decisionSubjects(declaration).map(({ subject, subjectId }) => `${subject}:${subjectId}`))
    for (const [index, entry] of declaration.decisions.entries.entries()) {
        if (!subjects.has(`${entry.subject}:${entry.subject_id}`)) ctx.addIssue({ code: 'custom', path: ['decisions', 'entries', index, 'subject_id'], message: 'decision references an undeclared subject' })
    }
})

export type DecisionSubject = Readonly<{ subject: typeof DECISION_SUBJECTS[number]; subjectId: string; service?: string }>

/** Every structural choice the rendered stack makes, in decision-log order; each may or may not have an entry. */
export function decisionSubjects(declaration: Pick<GeneratedEnvironment, 'services' | 'volumes' | 'data' | 'vendors'>): readonly DecisionSubject[] {
    const subjects: DecisionSubject[] = [
        ...declaration.services.map((service) => ({ subject: 'service' as const, subjectId: service.id, service: service.id })),
        ...declaration.volumes.map((volume) => ({ subject: 'volume' as const, subjectId: volume.id })),
        ...(declaration.data ? [{ subject: 'data-default' as const, subjectId: declaration.data.default_mode }] : []),
        ...(declaration.data?.modes ?? []).map((mode) => ({ subject: 'data-mode' as const, subjectId: mode.mode })),
        ...(declaration.data?.restore ? [{ subject: 'restore' as const, subjectId: 'policy' }] : []),
        ...declaration.services.flatMap((service) => service.mounts.map((mount) => ({ subject: 'mount' as const, subjectId: `${service.id}:${mount.kind}:${mount.source}:${mount.target}`, service: service.id }))),
        ...declaration.services.flatMap((service) => service.ports.map((port) => ({ subject: 'port' as const, subjectId: `${service.id}:${port.name}`, service: service.id }))),
        ...declaration.vendors.map((vendor) => ({ subject: 'vendor' as const, subjectId: vendor.id })),
    ]
    return subjects.sort((left, right) => `${left.subject}:${left.subjectId}`.localeCompare(`${right.subject}:${right.subjectId}`))
}

export type GeneratedEnvironment = z.infer<typeof GeneratedEnvironment>
export type DataMode = z.infer<typeof DataMode>
export type VendorPosture = z.infer<typeof VendorPosture>

export const Environment = z
    .object({
        addressing: AddressingPosture.optional(),
        authentication: AuthPosture.optional(),
        posture_requirements: z.array(PostureRequirement).min(1).max(128).optional(),
        machine: MachineFloor.optional(),
        resettable_volumes: z.array(ResettableVolumeId).default([]),
        generated_host_paths: z.array(GeneratedHostPath).default([]),
        compose_files: z.array(LocalComposePath).default([]),
        entrypoint_derivatives: z.array(EntrypointDerivative).default([]),
        install_policies: z.array(InstallPolicy).default([]),
        runtime_measurements: z.array(RuntimeMeasurement).default([]),
        generated: GeneratedEnvironment.optional(),
    })
    .strict()
    .superRefine((environment, ctx) => {
        const identities = {
            resettable_volumes: environment.resettable_volumes,
            generated_host_paths: environment.generated_host_paths,
            compose_files: environment.compose_files,
            entrypoint_derivatives: environment.entrypoint_derivatives.map((row) => row.name),
            install_policies: environment.install_policies.map((row) => row.volume),
            runtime_measurements: environment.runtime_measurements.map((row) => row.runtime),
            posture_requirements: environment.posture_requirements?.map((row) => row.requirement) ?? [],
        }

        for (const [field, values] of Object.entries(identities)) {
            if (hasDuplicate(values)) {
                ctx.addIssue({ code: 'custom', path: [field], message: `${field} contains a duplicate identity` })
            }
        }

        const selectors = environment.install_policies.map((row) => `${row.toolchain}\0${row.lockfile}`)
        if (hasDuplicate(selectors)) {
            ctx.addIssue({
                code: 'custom',
                path: ['install_policies'],
                message: 'install_policies contains a duplicate toolchain and lockfile selector',
            })
        }
    })

const SiblingGeneratedDerivation = z.object({
    service: GeneratedService.omit({ id: true, sibling: true, mounts: true, profiles: true }),
    checkout_mount: z.object({
        target: ContainerPath,
        source_type: z.literal('directory'),
    }).strict(),
    additional_mounts: GeneratedService.shape.mounts.optional().default([]),
    port_defaults: z.record(EnvironmentName, z.number().int().min(1).max(65535)).refine(
        (ports) => Object.keys(ports).length <= STRUCTURED_INPUT_ENTRY_LIMIT,
        `port defaults must not exceed ${STRUCTURED_INPUT_ENTRY_LIMIT} entries`,
    ),
    entrypoints: z.array(EntrypointDerivative).max(256),
    volumes: GeneratedVolumes.optional(),
    install_policies: z.array(InstallPolicy).max(256).optional(),
    decisions: DecisionEntries.min(1),
    provenance: Provenance,
}).strict().superRefine((generated, ctx) => {
    const hostVariables = generated.service.ports.map((port) => port.host_variable)
    const defaults = Object.keys(generated.port_defaults)
    if (hasDuplicate(hostVariables) || hostVariables.length !== defaults.length
        || hostVariables.some((name) => !defaults.includes(name))) {
        ctx.addIssue({ code: 'custom', path: ['port_defaults'], message: 'row port defaults must exactly match service host variables' })
    }
    if (hasDuplicate(generated.entrypoints.map((entrypoint) => entrypoint.name))) {
        ctx.addIssue({ code: 'custom', path: ['entrypoints'], message: 'row entrypoints contain a duplicate identity' })
    }
    for (const [index, entrypoint] of generated.entrypoints.entries()) {
        if (!defaults.includes(entrypoint.port)) {
            ctx.addIssue({ code: 'custom', path: ['entrypoints', index, 'port'], message: 'row entrypoint references a port outside its row' })
        }
    }
})

const McpSourceReference = z.object({
    path: SafeRelativePath.max(4096),
    format: z.literal('mcp-json'),
    provenance: Provenance,
}).strict()

const SiblingDerives = z.object({
    generated: SiblingGeneratedDerivation.optional(),
    mcp_sources: z.array(McpSourceReference).max(256).default([]),
}).strict().superRefine((derives, ctx) => {
    if (!derives.generated && derives.mcp_sources.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'derives must declare generated data or MCP sources' })
    }
    if (hasDuplicate(derives.mcp_sources.map((source) => source.path))) {
        ctx.addIssue({ code: 'custom', path: ['mcp_sources'], message: 'MCP source references contain a duplicate path' })
    }
})

// A lane that touches live data or local hardware. Never in a default bring-up, never in CI,
// and it asks before it acts.
export const Gate = z.enum(['operator'])

export const OPERATOR_GATE_RISK_PATTERN = String.raw`\b(?:[lL][iI][vV][eE]|[pP][rR][oO][dD][uU][cC][tT][iI][oO][nN]|[hH][aA][rR][dD][wW][aA][rR][eE]|[sS][iI][mM][uU][lL][aA][tT][oO][rR])\b`
const OPERATOR_GATE_RISK_RE = new RegExp(OPERATOR_GATE_RISK_PATTERN)

export function requiresOperatorGate(sibling: { mount: Mount; purpose: string }): boolean {
    return sibling.mount === 'host' || OPERATOR_GATE_RISK_RE.test(sibling.purpose)
}

export const Sibling = z
    .object({
        // Also the projection filename prefix (`.sibling-<slug>-CLAUDE.md`), which is why it
        // is recorded rather than derived. Slug, directory and remote are routinely three
        // different names for one repository, and every one of them is load-bearing
        // somewhere.
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        // Relative to the siblings root and resolved without further checks by several
        // consumers, so the schema is where a hostile cockpit.toml is stopped. `.` is the
        // siblings root itself: a single-repository stack whose one sibling is the cockpit root, or a
        // cockpit started before any product repository exists, which grows with `sibling add`.
        dir: z.union([z.literal('.'), SafeRelativePath]),
        // Absent exactly when nothing is cloned. Never derived from `dir`: a directory is
        // named for local convenience, a remote for whatever the org called it.
        remote: z.string().min(1).optional(),
        branch: z.string().min(1).optional(),
        mount: Mount,
        acquire: Acquire,
        // The exported `*_DIR`. Recorded because it does not follow from the slug — a
        // `renderer` sibling may export ENGINE_DIR, and deriving RENDERER_DIR instead would
        // leave every consumer reading an unset variable.
        var: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        toolchain: Toolchain.default('none'),
        gate: Gate.optional(),
        // Why this repository cannot join the stack. Required on a host lane, because that
        // is a constraint someone had to discover and it will otherwise be rediscovered as a
        // bug: a simulator that cannot be containerised, a renderer that lives in a vendor's
        // cloud, a client that needs a display. Preflight prints this instead of reporting
        // the sibling broken.
        host_reason: z.string().min(1).optional(),
        // Which guide files this repository publishes. Projected into the cockpit as symlinks
        // to the live files — never copies, which are stale the moment the sibling edits its
        // own guide and report nothing. Defaulted rather than required: most repositories use
        // one or both of these, and one that does not is a row that says so.
        guides: z.array(SafeRelativePath).default(['CLAUDE.md', 'AGENTS.md']),
        // Setup writes this repository only when the declaration and its command-line approval agree.
        instruction_pointer: z.boolean().default(false),
        // Printed when the checkout is missing, so it says what the absence costs.
        purpose: z.string().min(1),
        environment_files: z.array(EnvironmentFile).optional(),
        derives: SiblingDerives.optional(),
    })
    .strict()
    .refine((s) => (s.acquire === 'none' ? !s.remote : true), {
        message: 'acquire "none" means nothing is ever cloned — remove `remote`',
        path: ['remote'],
    })
    .refine((s) => (s.acquire !== 'none' ? !!s.remote : true), {
        message: 'acquire "auto" or "manual" needs a `remote` to clone from',
        path: ['remote'],
    })
    .refine((s) => (s.mount === 'host' ? !!s.host_reason : true), {
        message:
            'mount "host" needs a `host_reason` — record why it cannot join the stack, ' +
            'or the next reader treats a hard constraint as a gap to close',
        path: ['host_reason'],
    })
    .refine((s) => (!requiresOperatorGate(s) ? true : s.gate === 'operator'), {
        message: 'a live, production, hardware, simulator, or host lane needs gate = "operator"',
        path: ['gate'],
    })
    .refine((s) => !s.instruction_pointer || s.dir !== '.', {
        message: 'the cockpit root already loads AGENTS.md and cannot point that file at itself',
        path: ['instruction_pointer'],
    })
    .refine(
        (s) => !s.environment_files || !hasDuplicate(s.environment_files.map((file) => file.instance)),
        { message: 'environment_files contains a duplicate instance path', path: ['environment_files'] },
    )
    .superRefine((sibling, ctx) => {
        const generated = sibling.derives?.generated
        if (!generated) return
        if (sibling.mount === 'none' || sibling.mount === 'host') {
            ctx.addIssue({ code: 'custom', path: ['derives', 'generated'], message: 'generated rows require an always or profile mount' })
        }
        const owned = new Map<string, Set<string>>([
            ['service', new Set([sibling.slug])],
            ['volume', new Set((generated.volumes ?? []).map((volume) => volume.id))],
            ['mount', new Set([
                `${sibling.slug}:bind:.:${generated.checkout_mount.target}`,
                ...generated.additional_mounts.map((mount) => `${sibling.slug}:${mount.kind}:${mount.source}:${mount.target}`),
            ])],
            ['port', new Set(generated.service.ports.map((port) => `${sibling.slug}:${port.name}`))],
        ])
        for (const [index, decision] of generated.decisions.entries()) {
            if (!owned.get(decision.subject)?.has(decision.subject_id)) {
                ctx.addIssue({ code: 'custom', path: ['derives', 'generated', 'decisions', index, 'subject_id'], message: 'row decision references structure outside its row' })
            }
        }
    })

// Only host-published ports and browser-facing URLs carry the offset. Container-internal
// DNS and ports never do — that invariant is what lets several stacks run side by side on
// byte-identical service config with only the published edge differing.
export const Ports = z
    .object({
        step: z.number().int().positive().default(100),
        count: z.number().int().positive().default(27),
        bases: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.number().int().min(1).max(65535)),
    })
    .strict()
    .superRefine((ports, context) => {
        const memberCount = ports.count * Object.keys(ports.bases).length
        if (!Number.isSafeInteger(memberCount) || memberCount > STRUCTURED_INPUT_ENTRY_LIMIT) {
            context.addIssue({
                code: 'custom',
                message: `ports.count multiplied by the number of bases must not exceed ${STRUCTURED_INPUT_ENTRY_LIMIT}`,
                path: ['count'],
            })
        }
        // Stack n publishes each base plus n * step, so two bases whose distance is a multiple of
        // step below count * step hand one port to two stacks. Leasing only refuses that at `up`,
        // after `check` passed; the config is wrong, so the config check names it.
        const entries = Object.entries(ports.bases).sort(([, left], [, right]) => left - right)
        const spread = entries.length === 0 ? 0 : entries.at(-1)![1] - entries[0]![1]
        for (const [index, [lower, lowerBase]] of entries.entries()) {
            for (const [upper, upperBase] of entries.slice(index + 1)) {
                const distance = upperBase - lowerBase
                if (distance % ports.step !== 0 || distance / ports.step >= ports.count) continue
                const stacks = distance / ports.step
                context.addIssue({
                    code: 'custom',
                    path: ['bases', upper],
                    message: distance === 0
                        ? `${lower} and ${upper} share base ${lowerBase}; give each variable its own base`
                        : `${lower} (${lowerBase}) and ${upper} (${upperBase}) overlap: stack ${stacks}'s ${lower} is stack 0's ${upper} `
                            + `with step ${ports.step}; set [ports] step above the bases' spread (at least ${spread + 1}) `
                            + 'or move a base so no two differ by a multiple of step',
                })
            }
        }
    })

const GuardHosts = z.array(z.string().regex(GUARD_HOST_PATTERN)).max(GUARD_HOST_LIMITS.rows)
    .superRefine((hosts, ctx) => {
        const seen = new Set<string>()
        for (const [index, host] of hosts.entries()) {
            const normalized = normalizeGuardHost(host)
            if (seen.has(normalized)) ctx.addIssue({ code: 'custom', path: [index], message: 'guard hosts must be unique after removing one leading wildcard' })
            seen.add(normalized)
        }
    })
    .describe('Declared guard hosts; uniqueness after removing one leading wildcard is enforced at runtime.')

const GuardRuleText = z.string().min(1).max(512).regex(/\S/).regex(/^[^\x00-\x1f\x7f-\x9f]+$/u)
const GuardAllow = z.object({
    argv: GuardCommandArgv,
    reason: GuardRuleText,
    cwd: z.union([z.literal('.'), SafeRelativePath.max(4096)]).optional(),
}).strict()
const GuardDeny = z.union([
    z.object({ prefix: GuardCommandArgv, reason: GuardRuleText, fix: GuardRuleText.optional() }).strict(),
    z.object({ contains: GuardCommandArgv, reason: GuardRuleText, fix: GuardRuleText.optional() }).strict(),
])

export const Guards = z
    .object({
        hosted_db_hosts: GuardHosts.default([]),
        vendor_endpoint_hosts: GuardHosts.default([]),
        protected_branches: z.array(z.string()).default(['main', 'master']),
        // Codex has no `ask` tier. A prompt that cannot be shown must refuse, not proceed.
        ask_is_deny_on: z.array(z.string()).default(['codex']),
        allow: z.array(GuardAllow).max(64).default([]),
        deny: z.array(GuardDeny).max(64).default([]),
    })
    .strict()

// THE approval list. A server absent from it is generated disabled on every harness, so the
// three cannot disagree about what may start.
export const Mcp = z
    .object({
        approved: z.array(z.string()).default([]),
    })
    .strict()

export const Workorders = z
    .object({
        // Consumers may lower the repeated-failure limit, never raise it.
        attempt_cap: z.number().int().min(1).max(2).default(2),
        // Consumer values may lower these framework maxima, but cannot raise them.
        wip_cap: z.number().int().min(1).max(3).default(3),
        programme_wip_cap: z.number().int().min(1).max(1).default(1),
    })
    .strict()

const BrowserImage = z.object({
    reference: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
    driver_version: z.string().regex(/^\d+\.\d+\.\d+$/),
}).strict()

const BrowserArtifactRoots = z.object({
    runner: GeneratedHostPath,
    mcp: GeneratedHostPath,
    cli: GeneratedHostPath,
    auth: GeneratedHostPath,
    debugger: GeneratedHostPath,
}).strict().superRefine((artifacts, ctx) => {
    const paths = Object.values(artifacts)
    for (const [index, path] of paths.entries()) {
        if (paths.some((other, otherIndex) => index !== otherIndex && (path === other || path.startsWith(`${other}/`)))) {
            ctx.addIssue({ code: 'custom', message: 'browser artifact roots must be distinct and non-overlapping' })
            break
        }
    }
})

export const Browser = z.object({
    engine: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
    network_exposure: z.string().min(1).max(512).regex(/^[a-z0-9.*:<>\[\],-]+$/).refine((value) => {
        const rules = value.split(',')
        return rules.length <= 32 && rules.every((rule) => rule.length > 0) && new Set(rules).size === rules.length
    }, 'browser network exposure requires bounded unique rules').default('<loopback>'),
    network_exposure_reason: z.string().min(1).max(512).refine((value) => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value), 'browser exposure reason must be bounded plain text').optional(),
    harnesses: z.array(z.object({
        target: z.enum(GUARD_SURFACE_TARGETS),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
    }).strict()).min(1).max(GUARD_SURFACE_TARGETS.length).refine(
        (rows) => !hasDuplicate(rows.map((row) => row.target)),
        'browser harness targets must be unique',
    ),
    images: z.object({ runner: BrowserImage.extend({ architectures: z.array(z.enum(['amd64', 'arm64'])).min(1).max(2).refine((values) => !hasDuplicate(values), 'browser image architectures must be unique').optional() }), mcp: BrowserImage }).strict(),
    runner_health_measurement: HealthMeasurement.optional(),
    resources: GeneratedService.shape.resources,
    project: z.object({
        manifest: GeneratedHostPath.optional(),
        manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        lockfile: GeneratedHostPath,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        driver_version: z.string().regex(/^\d+\.\d+\.\d+$/),
    }).strict(),
    endpoint: z.string().url().optional(),
    max_clients: z.number().int().min(1).max(64),
    proxy: z.object({
        host_variable: EnvironmentName.optional(),
        server_port: z.number().int().min(1).max(65535),
        proxy_port: z.number().int().min(1).max(65535),
        allowed_hosts: z.array(z.string().min(1).max(260)).min(1).max(64),
        bind: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
    }).strict(),
    resolver: z.array(z.object({
        hostname: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/),
        address: z.union([z.ipv4(), z.ipv6()]),
    }).strict()).max(64).default([]),
    authentication: z.object({
        policy: z.enum(['none', 'serialized', 'per-worker']),
        states: z.array(z.object({
            worker: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
            path: GeneratedHostPath,
            source: z.literal('seeded'),
        }).strict()).max(64).default([]),
    }).strict(),
    data: z.object({
        mode: DataMode,
        isolated: z.boolean(),
        reaches_production: z.boolean(),
    }).strict(),
    request_preapproval: z.boolean().default(false),
    headed: z.boolean().default(false),
    artifacts: BrowserArtifactRoots,
}).strict().superRefine((browser, ctx) => {
    if (browser.resources && !browser.endpoint) {
        ctx.addIssue({ code: 'custom', path: ['resources'], message: 'browser resource ceilings require a generated runner endpoint' })
    }
    try {
        parseBrowserNetworkExposure(browser.network_exposure, browser.network_exposure_reason)
    } catch (error) {
        ctx.addIssue({ code: 'custom', path: ['network_exposure'], message: error instanceof Error ? error.message : 'invalid browser network exposure' })
    }
    if ((browser.project.manifest === undefined) !== (browser.project.manifest_sha256 === undefined)) {
        ctx.addIssue({ code: 'custom', path: ['project'], message: 'browser project manifest path and digest must be declared together' })
    }
    if (browser.images.runner.driver_version !== browser.project.driver_version
        || browser.images.mcp.driver_version !== browser.project.driver_version) {
        ctx.addIssue({ code: 'custom', path: ['images'], message: 'browser image and project driver versions must match' })
    }
    if (browser.proxy.server_port === browser.proxy.proxy_port) {
        ctx.addIssue({ code: 'custom', path: ['proxy', 'proxy_port'], message: 'browser server and proxy ports must differ' })
    }
    if (hasDuplicate(browser.proxy.allowed_hosts)) {
        ctx.addIssue({ code: 'custom', path: ['proxy', 'allowed_hosts'], message: 'browser proxy hosts must be unique' })
    }
    if (browser.proxy.allowed_hosts.some((value) => !browserProxyAuthorityMatches(value, browser.proxy.proxy_port))) {
        ctx.addIssue({ code: 'custom', path: ['proxy', 'allowed_hosts'], message: 'browser proxy hosts must be exact authorities on the proxy port' })
    }
    if (browser.endpoint) {
        try {
            const endpoint = new URL(browser.endpoint)
            const spelling = /^ws:\/\/([^/?#]+)(\/[^?#]*)$/.exec(browser.endpoint)
            if (!spelling || spelling[2] !== endpoint.pathname || endpoint.protocol !== 'ws:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
                || !browser.proxy.allowed_hosts.includes(spelling[1]!)) throw new TypeError()
        } catch { ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'browser endpoint must use an allowed credential-free ws:// authority; TLS termination is unavailable' }) }
    }
    const workers = browser.authentication.states.map((state) => state.worker)
    const paths = browser.authentication.states.map((state) => state.path)
    if (hasDuplicate(workers) || hasDuplicate(paths)) {
        ctx.addIssue({ code: 'custom', path: ['authentication', 'states'], message: 'browser authentication workers and state paths must be unique' })
    }
    if (paths.some((path) => !path.startsWith(`${browser.artifacts.auth}/`))) {
        ctx.addIssue({ code: 'custom', path: ['authentication', 'states'], message: 'browser authentication state must stay inside the auth artifact root' })
    }
    if (browser.request_preapproval && (browser.data.mode === 'restored' || !browser.data.isolated || browser.data.reaches_production)) {
        ctx.addIssue({ code: 'custom', path: ['request_preapproval'], message: 'browser preapproval requires isolated empty or seeded data without production reach' })
    }
})

const TestingName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const TestingCommand = z.array(z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value))).min(1).max(128)
export const Testing = z.object({
    stages: z.array(z.object({
        id: TestingName,
        command: TestingCommand,
        requires_stack: z.boolean(),
    }).strict()).min(1).max(128),
    gates: z.array(z.object({
        id: TestingName,
        tier: z.enum(['targeted', 'full']),
        stages: z.array(TestingName).min(1).max(128),
        changes: z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
    }).strict()).min(1).max(128),
    native_hooks: z.object({
        install: z.enum(['inspect', 'explicit-native']).default('inspect'),
    }).strict(),
    native_hook_policy: z.object({
        path: SafeRelativePath.max(4096),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().optional(),
}).strict().superRefine((testing, ctx) => {
    const stageIds = testing.stages.map((stage) => stage.id)
    const gateIds = testing.gates.map((gate) => gate.id)
    if (hasDuplicate(stageIds)) ctx.addIssue({ code: 'custom', path: ['stages'], message: 'testing stage identities must be unique' })
    if (hasDuplicate(gateIds)) ctx.addIssue({ code: 'custom', path: ['gates'], message: 'testing gate identities must be unique' })
    for (const [index, gate] of testing.gates.entries()) {
        if (hasDuplicate(gate.stages) || gate.stages.some((stage) => !stageIds.includes(stage))) {
            ctx.addIssue({ code: 'custom', path: ['gates', index, 'stages'], message: 'testing gates require unique declared stages' })
        }
    }
    if (testing.native_hooks.install === 'explicit-native' && !testing.native_hook_policy
        || testing.native_hooks.install === 'inspect' && testing.native_hook_policy) {
        ctx.addIssue({ code: 'custom', path: ['native_hook_policy'], message: 'native hook policy is required only for explicit native installation' })
    }
})

export const CockpitMeta = z
    .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        // Resolved from the MAIN checkout, never from the cwd's parent — a nested linked
        // checkout must still find the declared sibling root.
        siblings_root: z.string().default('..'),
        guide: z.string().default('AGENTS.md'),
        // preflight FAILS over it. A cap that only warns is a cap that is always slightly
        // exceeded; adherence falls as the guide grows.
        guide_cap: z.number().int().positive().default(200),
    })
    .strict()

const SurfaceName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(128)
const SurfaceSha256 = z.string().regex(/^[a-f0-9]{64}$/)
const SurfaceBytes = z.string().max(65_536).refine((bytes) => Buffer.byteLength(bytes) <= 65_536, {
    message: 'surface source bytes exceed the 65536-byte scalar limit',
})

function hasYamlOnlyMarkdownFrontmatter(path: string, bytes: string): boolean {
    if (!path.endsWith('.md')) return true
    const normalized = bytes.charCodeAt(0) === 0xFEFF ? bytes.slice(1) : bytes
    if (!normalized.startsWith('---')) return true
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized)
    if (!match) return false
    try {
        const document = parseDocument(match[1]!, { uniqueKeys: true })
        if (document.errors.length > 0 || document.warnings.length > 0) return false
        document.toJS({ maxAliasCount: 0 })
        return true
    } catch { return false }
}

export const SurfaceSource = z.object({
    path: SurfacePath,
    bytes: SurfaceBytes,
}).strict().superRefine((source, ctx) => {
    if (!hasYamlOnlyMarkdownFrontmatter(source.path, source.bytes)) {
        ctx.addIssue({
            code: 'custom',
            path: ['bytes'],
            message: 'Markdown frontmatter must use an unqualified YAML delimiter and valid bounded YAML',
        })
    }
})

export const SurfaceOverrideReference = z.object({
    name: SurfaceName,
    sha256: SurfaceSha256,
}).strict()

export const SurfaceDeclaration = z.object({
    name: SurfaceName,
    feature: z.enum(SURFACE_FEATURES),
    sources: z.array(SurfaceSource).min(1).max(256),
    source: SurfacePath,
    replaces: SurfaceOverrideReference.optional(),
}).strict().superRefine((declaration, ctx) => {
    if (!surfaceSourcesMatchFeature(declaration.sources, declaration.feature)) {
        ctx.addIssue({ code: 'custom', path: ['sources'], message: 'surface sources must match their feature and include every skill definition' })
    }
    if (hasDuplicate(declaration.sources.map((source) => source.path))) {
        ctx.addIssue({ code: 'custom', path: ['sources'], message: 'surface source paths must be unique' })
    }
    if (declaration.replaces && declaration.replaces.name !== declaration.name) {
        ctx.addIssue({ code: 'custom', path: ['replaces', 'name'], message: 'an override must name its declaration identity' })
    }
})

export const SurfaceOverlay = SurfaceDeclaration.safeExtend({
    feature: z.enum(['rules', 'subagents', 'skills', 'hooks']),
})

// A team's own harness settings file that cockpit moved under cockpit/adopted/ and merges with its
// rendering. `sha256` records the bytes that were moved; it is a record for review, not a lock:
// the adopted copy is consumer-owned, and the next sync re-merges whatever it holds.
export const SurfaceAdoption = z.object({
    path: z.enum(ADOPTABLE_SURFACE_PATHS),
    source: SurfacePath,
    sha256: SurfaceSha256,
    adopted_on: z.string().date(),
    provenance: Provenance,
}).strict().superRefine((row, ctx) => {
    if (row.source !== `${ADOPTED_SURFACE_ROOT}/${row.path}`) {
        ctx.addIssue({ code: 'custom', path: ['source'], message: `an adopted surface is kept at ${ADOPTED_SURFACE_ROOT}/<path>` })
    }
    if (row.provenance.kind !== 'declared') {
        ctx.addIssue({ code: 'custom', path: ['provenance', 'kind'], message: 'an adopted surface is declared by the team that owns it' })
    }
})

const HarnessMechanism = z.object({
    module: SurfacePath,
    export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).max(128),
}).strict()

const HarnessCapabilityBase = {
    feature: z.enum(SURFACE_FEATURES),
    measured_on: z.string().date(),
} as const

const HarnessEmittedCapability = {
    ...HarnessCapabilityBase,
    spelling: SurfacePath,
    control: SurfacePath,
    mechanism: HarnessMechanism,
} as const

export const CustomHarnessCapability = z.discriminatedUnion('state', [
    z.object({
        ...HarnessEmittedCapability,
        state: z.literal('enforced'),
        evidence: z.object({ reference: SurfacePath, sha256: SurfaceSha256 }).strict(),
    }).strict(),
    z.object({
        ...HarnessEmittedCapability,
        state: z.literal('instructed'),
    }).strict(),
    z.object({
        ...HarnessCapabilityBase,
        state: z.literal('unavailable'),
        reason: DeclarationReason,
    }).strict(),
])

export const CustomHarness = z.object({
    name: SurfaceName.regex(new RegExp(`^(?!(?:${SURFACE_TARGETS.join('|')})$)`), 'custom harness names cannot replace shipped targets'),
    features: z.array(z.enum(SURFACE_FEATURES)).length(SURFACE_FEATURES.length),
    capabilities: z.array(CustomHarnessCapability).length(SURFACE_FEATURES.length),
}).strict().superRefine((harness, ctx) => {
    const features = harness.capabilities.map((capability) => capability.feature)
    if (hasDuplicate(harness.features) || hasDuplicate(features)
        || SURFACE_FEATURES.some((feature) => !harness.features.includes(feature) || !features.includes(feature))) {
        ctx.addIssue({ code: 'custom', path: ['features'], message: 'features must exactly match unique capability rows' })
    }
    const spellings = harness.capabilities.flatMap((capability) => capability.state === 'unavailable' ? [] : [capability.spelling])
    if (hasDuplicate(spellings)) {
        ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'emitted capability spellings must be unique' })
    }
})

export const Surfaces = z.object({
    overlays: z.array(SurfaceOverlay).max(256).default([]),
    harnesses: z.array(CustomHarness).max(64).default([]),
    bundles: z.array(z.enum(SURFACE_BUNDLE_FORMATS)).max(SURFACE_BUNDLE_FORMATS.length).default([]),
    adopted: z.array(SurfaceAdoption).max(ADOPTABLE_SURFACE_PATHS.length).default([]),
}).strict().superRefine((surfaces, ctx) => {
    if (hasDuplicate(surfaces.adopted.map((row) => row.path))) {
        ctx.addIssue({ code: 'custom', path: ['adopted'], message: 'each harness settings file is adopted at most once' })
    }
    if (hasDuplicate(surfaces.overlays.map((overlay) => overlay.name))) {
        ctx.addIssue({ code: 'custom', path: ['overlays'], message: 'overlay names must be unique' })
    }
    if (hasDuplicate(surfaces.harnesses.map((harness) => harness.name))) {
        ctx.addIssue({ code: 'custom', path: ['harnesses'], message: 'custom harness names must be unique' })
    }
})

export function configurationDefaults() {
    return {
        cockpit: CockpitMeta.omit({ name: true }).parse({}),
        sibling: {
            toolchain: Sibling.shape.toolchain.parse(undefined),
            guides: Sibling.shape.guides.parse(undefined),
            instruction_pointer: Sibling.shape.instruction_pointer.parse(undefined),
        },
        ports: {
            step: Ports.shape.step.parse(undefined),
            count: Ports.shape.count.parse(undefined),
        },
        guards: Guards.parse({}),
        mcp: Mcp.parse({}),
        workorders: Workorders.parse({}),
        environment: Environment.parse({}),
        surfaces: Surfaces.parse({}),
    }
}

export const CockpitConfig = z
    .object({
        cockpit: CockpitMeta,
        sibling: z.array(Sibling).min(1),
        ports: Ports,
        guards: Guards.prefault({}),
        mcp: Mcp.prefault({}),
        workorders: Workorders.prefault({}),
        browser: Browser.optional(),
        testing: Testing.optional(),
        environment: Environment.prefault({}),
        surfaces: Surfaces.prefault({}),
    })
    .strict()
    .superRefine((cfg, ctx) => {
        const seen = new Map<string, string>()
        for (const [i, s] of cfg.sibling.entries()) {
            for (const [field, value] of [
                ['slug', s.slug],
                ['dir', s.dir],
                ['var', s.var],
            ] as const) {
                const key = `${field}:${value}`
                const first = seen.get(key)
                if (first !== undefined) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['sibling', i, field],
                        message: `duplicate ${field} "${value}" — also on sibling "${first}"`,
                    })
                }
                seen.set(key, s.slug)
            }
        }

        const leasedPorts = new Set(Object.keys(cfg.ports.bases))

        if (cfg.browser) {
            if (cfg.browser.resources && !cfg.environment.generated) {
                ctx.addIssue({ code: 'custom', path: ['browser', 'resources'], message: 'browser resource ceilings require environment.generated' })
            }
            const proxyVariable = cfg.browser.proxy.host_variable
            if (proxyVariable !== undefined && cfg.ports.bases[proxyVariable] !== cfg.browser.proxy.proxy_port) {
                ctx.addIssue({ code: 'custom', path: ['browser', 'proxy', 'host_variable'], message: 'browser proxy lease must name a configured base matching the proxy port' })
            }
            const artifacts = Object.values(cfg.browser.artifacts)
            const declared = cfg.environment.generated_host_paths
            if (artifacts.length !== declared.length || artifacts.some((path) => !declared.includes(path))) {
                ctx.addIssue({ code: 'custom', path: ['browser', 'artifacts'], message: 'browser artifact roots must exactly match generated host path ownership' })
            }
            if (!cfg.environment.addressing || !cfg.environment.authentication || !cfg.environment.posture_requirements) {
                ctx.addIssue({ code: 'custom', path: ['browser'], message: 'browser declarations require explicit environment posture declarations' })
            } else {
                if (!cfg.environment.posture_requirements.some((row) => row.addressing === cfg.environment.addressing
                    && row.authentication === cfg.environment.authentication)) {
                    ctx.addIssue({ code: 'custom', path: ['browser'], message: 'browser posture requirements must cover the selected environment declarations' })
                }
                if (cfg.environment.addressing === 'hostname' && cfg.browser.resolver.length === 0
                    || cfg.environment.addressing === 'port' && cfg.browser.resolver.length !== 0) {
                    ctx.addIssue({ code: 'custom', path: ['browser', 'resolver'], message: 'browser resolver declarations must match the environment addressing posture' })
                }
                const { policy, states } = cfg.browser.authentication
                if (cfg.environment.authentication === 'bypassed' && (policy !== 'none' || states.length !== 0)
                    || cfg.environment.authentication === 'real' && (policy === 'none'
                        || states.length !== (policy === 'serialized' ? 1 : cfg.browser.max_clients))) {
                    ctx.addIssue({ code: 'custom', path: ['browser', 'authentication'], message: 'browser authentication declarations must match the environment posture and client cap' })
                }
            }
        }
        for (const [index, derivative] of cfg.environment.entrypoint_derivatives.entries()) {
            if (!leasedPorts.has(derivative.port)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['environment', 'entrypoint_derivatives', index, 'port'],
                    message: `entrypoint derivative references undeclared port "${derivative.port}"`,
                })
            }
        }

        const generatedRows = cfg.sibling.flatMap((sibling, index) => sibling.derives?.generated
            ? [{ sibling, index, generated: sibling.derives.generated }]
            : [])
        if (generatedRows.length > 0 && !cfg.environment.generated) {
            ctx.addIssue({
                code: 'custom',
                path: ['environment', 'generated'],
                message: 'row-generated data requires a global generated environment baseline',
                params: { cockpitCode: 'REGISTRY_GENERATED_BASELINE_MISSING' },
            })
        }
        const globalGenerated = cfg.environment.generated
        const uniqueAcrossRows = (values: readonly { value: string; path: (string | number)[] }[], message: string) => {
            const seenValues = new Set<string>()
            for (const item of values) {
                if (seenValues.has(item.value)) ctx.addIssue({ code: 'custom', path: item.path, message })
                seenValues.add(item.value)
            }
        }
        uniqueAcrossRows([
            ...Object.keys(cfg.ports.bases).map((value) => ({ value, path: ['ports', 'bases', value] })),
            ...generatedRows.flatMap(({ index, generated }) => Object.keys(generated.port_defaults).map((value) => ({ value, path: ['sibling', index, 'derives', 'generated', 'port_defaults', value] }))),
        ], 'row and global port defaults must not overlap')
        uniqueAcrossRows([
            ...(globalGenerated?.services ?? []).map((service) => ({ value: service.id, path: ['environment', 'generated', 'services'] })),
            ...generatedRows.map(({ sibling, index }) => ({ value: sibling.slug, path: ['sibling', index, 'derives', 'generated', 'service'] })),
        ], 'generated service identities must be unique across global and row declarations')
        uniqueAcrossRows([
            ...(globalGenerated?.volumes ?? []).map((volume) => ({ value: volume.id, path: ['environment', 'generated', 'volumes'] })),
            ...generatedRows.flatMap(({ index, generated }) => (generated.volumes ?? []).map((volume) => ({ value: volume.id, path: ['sibling', index, 'derives', 'generated', 'volumes'] }))),
        ], 'generated volume identities must be unique across global and row declarations')
        uniqueAcrossRows([
            ...(globalGenerated?.decisions.entries ?? []).map((entry) => ({ value: entry.id, path: ['environment', 'generated', 'decisions', 'entries'] })),
            ...generatedRows.flatMap(({ index, generated }) => generated.decisions.map((entry) => ({ value: entry.id, path: ['sibling', index, 'derives', 'generated', 'decisions'] }))),
        ], 'generated decision identities must be unique across global and row declarations')
        uniqueAcrossRows([
            ...cfg.environment.entrypoint_derivatives.map((entrypoint) => ({ value: entrypoint.name, path: ['environment', 'entrypoint_derivatives'] })),
            ...generatedRows.flatMap(({ index, generated }) => generated.entrypoints.map((entrypoint) => ({ value: entrypoint.name, path: ['sibling', index, 'derives', 'generated', 'entrypoints'] }))),
        ], 'entrypoint identities must be unique across global and row declarations')
        const policies = [
            ...cfg.environment.install_policies.map((policy) => ({ policy, path: ['environment', 'install_policies'] as (string | number)[] })),
            ...generatedRows.flatMap(({ index, generated }) => (generated.install_policies ?? []).map((policy) => ({ policy, path: ['sibling', index, 'derives', 'generated', 'install_policies'] as (string | number)[] }))),
        ]
        uniqueAcrossRows(policies.map(({ policy, path }) => ({ value: policy.volume, path })), 'install policy volumes must be unique across global and row declarations')
        uniqueAcrossRows(policies.map(({ policy, path }) => ({ value: `${policy.toolchain}\0${policy.lockfile}`, path })), 'install policy selectors must be unique across global and row declarations')

        if (cfg.environment.generated) {
            const generated = cfg.environment.generated
            const siblings = new Set(cfg.sibling.map((sibling) => sibling.slug))
            const policies = new Set(cfg.environment.install_policies.map((policy) => policy.volume))
            for (const [index, service] of generated.services.entries()) {
                if (!siblings.has(service.sibling)) ctx.addIssue({ code: 'custom', path: ['environment', 'generated', 'services', index, 'sibling'], message: 'generated service references an undeclared sibling' })
                for (const [portIndex, port] of service.ports.entries()) {
                    if (!leasedPorts.has(port.host_variable)) ctx.addIssue({ code: 'custom', path: ['environment', 'generated', 'services', index, 'ports', portIndex, 'host_variable'], message: 'generated host port references an undeclared lease' })
                }
            }
            for (const [index, volume] of generated.volumes.entries()) {
                if (volume.install_policy !== undefined && !policies.has(volume.install_policy)) ctx.addIssue({ code: 'custom', path: ['environment', 'generated', 'volumes', index, 'install_policy'], message: 'dependency volume references an undeclared install policy' })
            }
            for (const [index, vendor] of generated.vendors.entries()) {
                for (const [endpointIndex, endpoint] of vendor.endpoints.entries()) {
                    const sibling = cfg.sibling.find((sibling) => sibling.slug === endpoint.supplier.sibling)
                    if (!sibling?.environment_files?.some((declared) => declared.template === endpoint.supplier.template)) ctx.addIssue({ code: 'custom', path: ['environment', 'generated', 'vendors', index, 'endpoints', endpointIndex, 'supplier'], message: 'endpoint supplier references an undeclared sibling environment template' })
                }
                for (const [fileIndex, file] of (vendor.shadow_files ?? []).entries()) {
                    const sibling = cfg.sibling.find((sibling) => sibling.slug === file.sibling)
                    if (!sibling?.environment_files?.some((declared) => declared.instance === file.instance)) ctx.addIssue({ code: 'custom', path: ['environment', 'generated', 'vendors', index, 'shadow_files', fileIndex], message: 'shadow references an undeclared sibling environment instance' })
                }
            }
        }

        // Deliberately NOT checked here: that a `profile:<name>` lane names a profile in
        // `profiles.default`. A profile lane is opt-in by definition — it exists precisely to
        // stay off until EXTRA_PROFILES turns it on — so absence from the default set is the
        // normal case, not a defect. The spelling is defined by the compose file,
        // which preflight reads and a schema cannot.
    })

export type CockpitConfig = z.infer<typeof CockpitConfig>
export type Sibling = z.infer<typeof Sibling>
export type Acquire = z.infer<typeof Acquire>
export type Toolchain = z.infer<typeof Toolchain>
export type AddressingPosture = z.infer<typeof AddressingPosture>
export type AuthPosture = z.infer<typeof AuthPosture>
export type EnvironmentFile = z.infer<typeof EnvironmentFile>
export type MachineFloor = z.infer<typeof MachineFloor>
export type ResettableVolumeId = z.infer<typeof ResettableVolumeId>
export type GeneratedHostPath = z.infer<typeof GeneratedHostPath>
export type EntrypointDerivative = z.infer<typeof EntrypointDerivative>
export type InstallPolicy = z.infer<typeof InstallPolicy>
export type RuntimeMeasurement = z.infer<typeof RuntimeMeasurement>
export type Browser = z.infer<typeof Browser>
export type Testing = z.infer<typeof Testing>
export type Provenance = z.infer<typeof Provenance>
export type GeneratedService = z.infer<typeof GeneratedService>
export type SurfaceSource = z.infer<typeof SurfaceSource>
export type SurfaceOverrideReference = z.infer<typeof SurfaceOverrideReference>
export type SurfaceDeclaration = z.infer<typeof SurfaceDeclaration>
export type SurfaceOverlay = z.infer<typeof SurfaceOverlay>
export type SurfaceAdoption = z.infer<typeof SurfaceAdoption>
export type CustomHarnessCapability = z.infer<typeof CustomHarnessCapability>
export type CustomHarness = z.infer<typeof CustomHarness>
export type Surfaces = z.infer<typeof Surfaces>

/** Rows the stack bind-mounts under the given profile set — the projection's import list. */
export function mounted(cfg: CockpitConfig, profiles: readonly string[]): Sibling[] {
    return cfg.sibling.filter(
        (s) => s.mount === 'always' || (s.mount.startsWith('profile:') && profiles.includes(s.mount.slice(8))),
    )
}
