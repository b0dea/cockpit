import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { parseDocument } from 'yaml'
import { browserProxyAuthorityMatches } from './browser/proxy.js'
import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'
import { GUARD_HOST_LIMITS, GUARD_HOST_PATTERN, normalizeGuardHost } from './guards/host.js'
import { ADOPTABLE_SURFACE_PATHS, ADOPTED_SURFACE_ROOT, SURFACE_BUNDLE_FORMATS, SURFACE_FEATURES, SURFACE_TARGETS, surfaceSourcesMatchFeature } from './surfaces/contract.js'
import { GUARD_SURFACE_TARGETS } from './surfaces/harness-registry.js'
import { RefusalError, errorCause } from './environment/contract.js'

export const mechanism = {
    id: 'configuration-schema',
    module: 'packages/cockpit/src/schema.ts',
    exports: [
        'UNCONFIRMABLE_ANSWERS',
        'TestingName',
        'Mount',
        'Acquire',
        'AddressingPosture',
        'AuthPosture',
        'Toolchain',
        'Gate',
        'EnvironmentFile',
        'MachineFloor',
        'MAX_COLD_START_SECONDS',
        'ResettableVolumeId',
        'GeneratedHostPath',
        'parseBrowserNetworkExposure',
        'BROWSER_DRIVER_VERSION',
        'EVALUATOR_COMMANDS',
        'SIBLING_DEFAULT_GUIDES',
        'browserDriversCompatible',
        'SafeUrlPath',
        'EntrypointDerivative',
        'InstallPolicy',
        'GuardCommandArgv',
        'GUARD_COMMAND_WORD_PATTERN',
        'ContainerPath',
        'EnvironmentName',
        'Provenance',
        'GeneratedService',
        'GeneratedEnvironment',
        'DECISIONS_PATH',
        'decisionSubjects',
        'DataMode',
        'VendorPosture',
        'Environment',
        'SiblingVariable',
        'deriveSiblingVariable',
        'Sibling',
        'Ports',
        'Guards',
        'Mcp',
        'Workorders',
        'Browser',
        'Testing',
        'TESTING_STAGE_TIMEOUT_MAX_SECONDS',
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
        'runtimeDeclarationSha256',
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
// `real` signs in through the product's provider, `bypassed` turns an existing sign-in off locally,
// and `none` is a product with no sign-in at all, so nothing can depend on one.
export const AuthPosture = z.enum(['real', 'bypassed', 'none'])

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
        template: SafeRelativePath.describe('Tracked template file the instance is created from.'),
        instance: SafeRelativePath.describe('Machine-local file created from the template and left out of version control.'),
    })
    .strict()
    .refine((file) => file.template !== file.instance, {
        message: 'template and instance must name different files',
        path: ['instance'],
    })

// `up` holds one authority window open while every service starts, and each start step runs for
// the declared budget. A budget beyond what that window can hold was silently cut to five minutes,
// so a stack that needed more was killed and reported unhealthy on every retry. An hour covers a
// first start that builds images and installs dependencies; a longer one is refused here.
export const MAX_COLD_START_SECONDS = 3_600

export const MachineFloor = z
    .object({
        runtime_memory_mb: z.number().int().positive().describe('Least memory in megabytes the container runtime must offer before the stack starts.'),
        runtime_cpus: z.number().positive().describe('Least number of CPUs the container runtime must offer before the stack starts.'),
        free_disk_mb: z.number().int().positive().describe('Least free disk space in megabytes the stack needs before it starts.'),
        cold_start_seconds: z.number().int().positive().max(MAX_COLD_START_SECONDS).describe('Seconds a first start may take; start fails and reports unhealthy beyond it. At most one hour.'),
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
        throw new RefusalError('browser network exposure must contain bounded Playwright hostname, IP, wildcard or loopback rules')
    }
    if (exposure === '<loopback>') {
        if (reason !== undefined) throw new RefusalError('browser network exposure reason is only valid for a wider decision')
        return Object.freeze({ value: exposure })
    }
    if (typeof reason !== 'string' || reason !== reason.trim() || reason.length === 0 || Buffer.byteLength(reason) > 512
        || /[\x00-\x1f\x7f]/.test(reason)) throw new RefusalError('wider browser network exposure requires a bounded explicit reason')
    return Object.freeze({ value: exposure, reason })
}

export const EntrypointDerivative = z
    .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('Name that identifies this entrypoint in command output.'),
        kind: z.enum(ENTRYPOINT_KINDS).describe('What the address is used for, such as an application origin or a callback URL.'),
        port: z.string().regex(/^[A-Z][A-Z0-9_]*$/).describe('Port-base variable from [ports.bases] whose leased port this address uses.'),
        path: SafeUrlPath.describe('Absolute URL path appended to the origin.'),
        hostname: z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+localhost(?![\s\S])/).optional().describe('Named local URL host, a subdomain of .localhost; omit to use 127.0.0.1.'),
        scheme: z.enum(['http', 'https']).optional().describe('URL scheme, http or https; omit to use http.'),
    })
    .strict()

const CommandArgv = z.array(z.string().min(1)).min(1)

// Unicode mode counts scalar values, excluding lone surrogate code units before UTF-8 encoding.
export const GUARD_COMMAND_WORD_PATTERN = '^[^\\x00-\\x1f\\x7f-\\x9f\\uD800-\\uDFFF]{1,128}(?![\\s\\S])'
export const GuardCommandArgv = z.array(z.string().regex(new RegExp(GUARD_COMMAND_WORD_PATTERN, 'u'))).min(1).max(32)

export const InstallPolicy = z
    .object({
        toolchain: Toolchain.exclude(['none']).describe('Toolchain whose dependencies this policy installs.'),
        volume: ResettableVolumeId.describe('Resettable volume that holds the installed dependencies.'),
        lockfile: SafeRelativePath.describe('Lockfile, relative to the sibling, that this policy applies to.'),
        install: CommandArgv.describe('Command, as an argument list, that installs the dependencies.'),
        load_probe: CommandArgv.describe('Command, as an argument list, that proves the installed dependencies load.'),
        build: GuardCommandArgv.optional().describe('Build command, as an argument list, when the product owns one.'),
        test: GuardCommandArgv.optional().describe('Test command, as an argument list, when the product owns one.'),
    })
    .strict()

function hasDuplicate(values: readonly string[]): boolean {
    return new Set(values).size !== values.length
}

const PostureRequirement = z.object({
    requirement: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).describe('Name of the posture requirement the product relies on.'),
    addressing: AddressingPosture.optional().describe('Addressing posture this requirement depends on; set at least one of addressing and authentication.'),
    authentication: AuthPosture.optional().describe('Authentication posture this requirement depends on; set at least one of addressing and authentication.'),
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
    source: SafeRelativePath.max(4096).describe('File or place the value came from, relative to the repository.'),
    observed_on: z.string().date().optional().describe('Date the source was looked at; required unless kind is declared.'),
    kind: z.enum(['declared', 'measured', 'inferred']).describe('How the value was established: declared by this file, measured, or inferred.'),
    reason: DeclarationReason.describe('Why the value is what it is.'),
    confirmed: z.boolean().optional().describe('Set to true once a person has confirmed an inferred value; inferred values require it.'),
}).strict().refine((value) => value.kind !== 'inferred' || value.confirmed === true, {
    path: ['confirmed'], message: 'inferred declarations require explicit confirmation',
}).refine((value) => value.kind === 'declared' || value.observed_on !== undefined, {
    path: ['observed_on'], message: 'measured and inferred provenance require observed_on',
})

const OverlayOperation = z.object({
    location: z.enum(['host', 'in-stack']).describe('Where the command runs: on the host or inside a stack service.'),
    service: DeclarationId.optional().describe('Stack service the command runs in; required when location is in-stack and not allowed otherwise.'),
    cwd: z.union([z.literal('.'), SafeRelativePath.max(4096)]).describe('Working directory for the command, relative to the sibling, or . for its root.'),
    argv: BoundedArgv.describe('Command to run, as an argument list.'),
    timeout_seconds: z.number().int().min(1).max(3600).describe('Seconds the command may run before it is stopped.'),
    // Absent means the nearest enclosing declaration's provenance applies.
    provenance: Provenance.optional().describe('Where this command came from; omit to use the enclosing declaration\'s provenance.'),
}).strict().refine((value) => value.location === 'in-stack' ? value.service !== undefined : value.service === undefined, {
    path: ['service'], message: 'only in-stack operations require a service',
})

const GeneratedHostAlias = z.object({
    hostname: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/).describe('Host name the service resolves to the given address.'),
    address: z.union([z.ipv4(), z.ipv6()]).describe('IPv4 or IPv6 address the host name resolves to.'),
}).strict()

const HealthMeasurement = z.object({ duration_seconds: z.number().positive().max(3600).describe('Measured seconds the service took to become healthy.'), provenance: Provenance.describe('Where the measurement came from.') }).strict()

export const GeneratedService = z.object({
    id: DeclarationId.describe('Identifier of the generated service.'),
    sibling: DeclarationId.describe('Sibling checkout the service is built from or mounts.'),
    role: z.enum(['service', 'one-shot']).default('service').describe('Whether the service stays running or runs once and exits.'),
    profiles: z.array(DeclarationId).max(64).default([]).describe('Compose profiles the service belongs to; it starts only when one is active.'),
    resources: z.object({
        memory_mb: z.number().int().min(6).max(Math.floor(Number.MAX_SAFE_INTEGER / 1_048_576)).describe('Memory limit in megabytes.'),
        // Bound the default 100 ms CPU quota within its signed 64-bit calculation.
        cpus: z.number().min(0.01).max(Number(((1n << 63n) - 1n) / 100_000_000_000_000n)).describe('CPU limit as a number of CPUs, fractions allowed.'),
        provenance: Provenance.describe('Where the ceilings came from.'),
    }).strict().optional().describe('Memory and CPU ceilings for the service.'),
    command: BoundedArgv.describe('Command the service runs, as an argument list.'),
    // Exactly one of `image` and `build` (checked with the environment). The manifest probe
    // stays required on an image: it is what verifies the declared architectures exist.
    image: z.object({
        reference: z.string().max(4096).regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/).describe('Image reference pinned by sha256 digest.'),
        reason: DeclarationReason.describe('Why this image is used.'),
        architectures: z.array(z.enum(['amd64', 'arm64'])).min(1).max(2).describe('CPU architectures the image must support.'),
        manifest_probe: OverlayOperation.describe('Command that checks the image manifest lists the declared architectures.'),
        registry_auth_probe: OverlayOperation.optional().describe('Command that checks the registry sign-in the image needs.'),
        provenance: Provenance.optional().describe('Where the image choice came from; omit to use the service\'s provenance.'),
    }).strict().optional().describe('Pinned prebuilt image to run; declare exactly one of image and build.'),
    // Built from the service's sibling checkout. Both paths are confined: `context` below the
    // sibling, `dockerfile` below the context, so a build can never reach outside the checkout.
    build: z.object({
        context: z.union([z.literal('.'), SafeRelativePath.max(4096)]).describe('Build context directory, relative to the sibling.'),
        dockerfile: SafeRelativePath.max(4096).optional().describe('Dockerfile path, relative to the build context.'),
    }).strict().optional().describe('Build the image from the sibling checkout; declare exactly one of image and build.'),
    ports: z.array(z.object({ name: DeclarationId.describe('Name of the published port.'), host_variable: EnvironmentName.describe('Environment variable that carries the leased host port.'), internal: z.number().int().min(1).max(65535).describe('Port the service listens on inside the container.'), host_ip: z.enum(['127.0.0.1', '::1', '0.0.0.0', '::']).default('127.0.0.1').describe('Host address the port is published on; defaults to loopback.') }).strict()).max(256).default([]).describe('Ports the service publishes on the host.'),
    host_aliases: z.array(GeneratedHostAlias).max(64).refine((aliases) => !hasDuplicate(aliases.map(({ hostname }) => hostname)), {
        message: 'generated service host aliases must name unique hostnames',
    }).optional().describe('Extra host names the service resolves to fixed addresses.'),
    // Host inputs belong to the service sibling; named volumes retain their declared identities.
    mounts: z.array(z.object({ kind: z.enum(['bind', 'volume', 'environment-file']).describe('Whether the source is a bind-mounted path, a named volume or an environment file.'), source: z.union([z.literal('.'), SafeRelativePath.max(4096)]).describe('Path in the sibling, or the declared volume id when kind is volume.'), target: ContainerPath.describe('Absolute path inside the container.'), source_type: z.enum(['file', 'directory']).optional().describe('Whether a bind source is a file or a directory; required for bind mounts.') }).strict().refine((mount) => mount.kind === 'volume' ? mount.source_type === undefined && mount.source !== '.' : mount.kind === 'environment-file' ? mount.source_type === 'file' : mount.source_type !== undefined, { path: ['source_type'], message: 'bind sources require their expected type and volume sources use declared identities' })).max(256).default([]).describe('Files, directories and volumes mounted into the service.'),
    dependencies: z.array(z.object({ service: DeclarationId.describe('Service this one waits for.'), condition: z.enum(['service_started', 'service_healthy', 'service_completed_successfully']).describe('State the other service must reach: started, healthy or completed successfully.'), reason: DeclarationReason.describe('Why the service needs this dependency.') }).strict()).max(256).default([]).describe('Other services that must reach a state before this one starts.'),
    health: z.object({
        // Without a tool probe a failing property probe cannot say whether the product or the
        // probe's own tool is missing; failure text names that gap instead of guessing.
        property: DeclarationReason.describe('What the probe proves about the product.'), probe: OverlayOperation.describe('Command that checks the property; it runs in the service\'s own image.'), tool_probe: OverlayOperation.optional().describe('Command that checks the probe\'s own tool exists, so a failure names the missing tool.'),
        interval_seconds: z.number().int().min(1).max(3600).describe('Seconds between probe runs.'),
        timeout_seconds: z.number().int().min(1).max(3600).describe('Seconds one probe run may take.'),
        retries: z.number().int().min(1).max(100).describe('Failed probe runs tolerated before the service is unhealthy.'),
        start_period_seconds: z.number().int().min(1).max(3600).describe('Seconds after start during which failures are not counted; at least the measured start time.'),
        measurement: HealthMeasurement.optional().describe('Measured start time the start period is checked against.'),
    }).strict().refine((health) => health.measurement === undefined || health.start_period_seconds >= health.measurement.duration_seconds, {
        path: ['start_period_seconds'], message: 'start period is shorter than its measurement',
    }).describe('How cockpit decides the service is healthy.'),
    // Pin files are read from this service sibling, including services without bind mounts.
    toolchain_pins: z.array(z.object({ path: SafeRelativePath.describe('Pin file in the sibling that names the toolchain version.'), pinned: z.string().min(1).max(256).describe('Version the pin file declares.'), observed: z.string().min(1).max(256).describe('Version actually observed for the pin.'), provenance: Provenance.describe('Where the observed version came from.') }).strict()).max(32).default([]).describe('Toolchain version pins read from files in the sibling.'),
    // Absent means the value is declared by the configuration file itself.
    provenance: Provenance.optional().describe('Where the service declaration came from; omit when this file declares it.'),
}).strict()

export const DataMode = z.enum(['empty', 'seeded', 'restored'])
export const VendorPosture = z.enum(['bypassed', 'stubbed', 'substituted', 'vendor-sandbox', 'record-replay', 'absent-and-gated'])

const DataOperation = z.object({
    id: DeclarationId.describe('Identifier of the step, referenced by other steps\' after list.'),
    kind: z.enum(['schema', 'sweep', 'fixtures', 'restore', 'rewrite']).describe('What the step does to the product data.'),
    operation: OverlayOperation.describe('Command the step runs.'),
    prerequisites: z.array(OverlayOperation).max(64).describe('Commands that must succeed before the step runs.'),
    after: z.array(DeclarationId).max(256).describe('Earlier steps in the same mode that must finish first.'),
    fresh_volume_only: z.boolean().describe('Run the step only when the data volume is new.'),
    // Absent means the enclosing data mode's provenance applies.
    provenance: Provenance.optional().describe('Where the step came from; omit to use the data mode\'s provenance.'),
}).strict()

const VendorDeclaration = z.object({
    id: DeclarationId.describe('Identifier of the third-party vendor.'), posture: VendorPosture.describe('How the stack handles this vendor locally: bypassed, stubbed, substituted, vendor sandbox, record-replay or absent and gated.'), reason: DeclarationReason.describe('Why this posture was chosen.'), provenance: Provenance.describe('Where the posture came from.'),
    endpoints: z.array(z.object({
        variable: EnvironmentName.describe('Environment variable that carries the vendor endpoint.'), sink: LocalEndpointUrl.describe('Local URL the endpoint is redirected to.'), runtime_service: DeclarationId.describe('Stack service that serves the sink.'),
        supplier: z.object({ sibling: DeclarationId.describe('Sibling that owns the template.'), template: SafeRelativePath.describe('Template file, relative to the sibling, that supplies the variable.') }).strict().describe('Sibling environment template that supplies the variable.'),
    }).strict()).min(1).max(256).describe('Vendor endpoints the product reads from the environment and the local sink each is pointed at.'),
    nonempty_variables: z.array(EnvironmentName).min(1).max(256).optional().describe('Environment variables that must hold a value for the product to start.'),
    egress_guard: z.object({
        flag: EnvironmentName.describe('Environment variable that turns the guard on.'),
        enabled_value: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).describe('Value the flag must hold for the guard to be on.'),
        local_service: DeclarationId.describe('Local service that stands in for the vendor.'),
    }).strict().optional().describe('Flag that makes the product refuse real vendor traffic.'),
    loader_probe: OverlayOperation.describe('Command that checks the product loads the vendor configuration.'), route_probe: OverlayOperation.describe('Command that checks vendor calls reach the local sink.'), egress_probe: OverlayOperation.describe('Command that checks no vendor call leaves the machine.'),
    placeholder: z.string().max(256).regex(/^cockpit:absent:[a-z0-9-]+$/).describe('Value written in place of the vendor credential, of the form cockpit:absent:<name>.'),
    shadow_files: z.array(z.object({ sibling: DeclarationId.describe('Sibling that owns the file.'), instance: SafeRelativePath.describe('Instance file, relative to the sibling.'), probe: OverlayOperation.describe('Command that checks the file does not shadow the declared configuration.') }).strict()).max(64).optional().describe('Instance files that must not override the vendor configuration.'),
    expiry: z.object({ expires_on: z.string().date().describe('Date the sandbox stops being valid.'), reason: DeclarationReason.describe('Why the sandbox expires on that date.'), probe: OverlayOperation.describe('Command that checks whether the sandbox is still valid.') }).strict().optional().describe('Expiry of the vendor sandbox; required for the vendor-sandbox posture.'),
    callback_reachability: z.object({ reachable: z.boolean().describe('True when the vendor can reach the local stack.'), alternative: DeclarationReason.describe('How callbacks are exercised when the vendor cannot reach the stack.'), reason: DeclarationReason.describe('Why the vendor can or cannot reach the stack.') }).strict().describe('Whether the vendor can call back into the local stack.'),
    // Steps run in the fixed order enable, timestamp, sign, dispatch, then the tamper probe.
    callback: z.object({
        enable: OverlayOperation.describe('Command that turns callbacks on.'),
        timestamp_source: OverlayOperation.describe('Command that supplies the timestamp the signature covers.'),
        fresh_window_seconds: z.number().int().min(1).max(3600).describe('Seconds a signed callback stays acceptable.'),
        // The digest is checked before each step that reads the fixture, so its raw bytes cannot drift.
        fixture: z.object({ path: SafeRelativePath.describe('Payload file, relative to the sibling.'), sha256: z.string().regex(/^[a-f0-9]{64}$/).describe('SHA-256 digest of the payload, checked before each use.') }).strict().describe('Callback payload file and its digest.'),
        sign: OverlayOperation.describe('Command that signs the payload.'), dispatch: OverlayOperation.describe('Command that delivers the signed payload to the product.'),
        tamper_probe: OverlayOperation.describe('Command that checks the product rejects a tampered payload.'),
    }).strict().optional().describe('Signed callback rehearsal: enable, timestamp, sign, dispatch, then a tamper check.'),
    tls: z.object({ generate_at_start: OverlayOperation.describe('Command that creates the certificate when the stack starts.'), append_trust_probe: OverlayOperation.describe('Command that checks the product trusts the generated certificate.'), hostname_probe: OverlayOperation.describe('Command that checks the certificate matches the vendor host name.') }).strict().optional().describe('Local certificate setup for the vendor host name.'),
    stub: z.object({ rejection_probe: OverlayOperation.describe('Command that checks the stub rejects an invalid request.'), outage_probe: OverlayOperation.describe('Command that checks the product copes with the stub being down.') }).strict().optional().describe('Probes for a stubbed vendor; required for the stubbed posture.'),
}).strict()

const GeneratedVolumes = z.array(z.object({
    id: DeclarationId.describe('Identifier of the named volume.'), purpose: z.enum(['dependencies', 'product-data']).describe('Whether the volume holds installed dependencies or product data.'),
    install_policy: ResettableVolumeId.optional().describe('Install policy volume that fills it; required for dependency volumes.'), provenance: Provenance.describe('Where the volume declaration came from.'),
}).strict()).max(256)

export const DECISIONS_PATH = 'docs/cockpit/environment-decisions.md'
const DECISION_SUBJECTS = ['service', 'volume', 'data-default', 'data-mode', 'restore', 'mount', 'port', 'vendor'] as const
const DecisionEntries = z.array(z.object({
    id: DeclarationId.describe('Identifier of the decision record.'), subject: z.enum(DECISION_SUBJECTS).describe('Kind of structure the decision is about.'),
    subject_id: z.string().min(1).max(4096).describe('Identity of the structure the decision is about.'),
    decided_on: z.string().date().describe('Date the decision was made.'), decision: DeclarationReason.describe('What was decided.'), rejected: z.array(DeclarationReason).min(1).max(64).describe('Alternatives that were considered and rejected.'),
    reason: DeclarationReason.describe('Why this was decided.'), provenance: Provenance.describe('Where the decision came from.'),
}).strict()).max(512)

export const GeneratedEnvironment = z.object({
    compose_file: SafeRelativePath.max(4096).describe('Path, relative to the cockpit, where the generated Compose file is written.'),
    services: z.array(GeneratedService).min(1).max(256).describe('Services of the generated stack.'),
    volumes: GeneratedVolumes.default([]).describe('Named volumes of the generated stack.'),
    // Absent means the stack has no product data step: `up` and `reset` skip it.
    data: z.object({
        volume: DeclarationId.describe('Product-data volume the data step fills.'),
        default_mode: DataMode.describe('Data mode used when none is chosen.'),
        modes: z.array(z.object({ mode: DataMode.describe('Data mode: empty, seeded or restored.'), operations: z.array(DataOperation).min(1).max(256).describe('Ordered steps that create the data for this mode.'), probes: z.array(OverlayOperation).min(1).max(64).describe('Commands that check the data is in the expected state.'), provenance: Provenance.describe('Where the mode came from.') }).strict()).min(1).max(3).describe('Data modes the stack supports, each with its steps.'),
        // Fixture determinism (stable keys, seeds) belongs to the product's writer: a seed it reads
        // goes in the fixture operation's argv, which reaches the product and its digest.
        fixtures: z.object({
            persona_source: SafeRelativePath.describe('File, relative to the cockpit, that describes the fixture personas.'),
            persona_outputs: z.array(z.object({ path: SafeRelativePath.describe('Output file path, relative to the cockpit.'), format: z.enum(['json', 'typescript']).describe('Output format, json or typescript.'), reason: DeclarationReason.describe('Why this output is generated.') }).strict()).max(64).describe('Files generated from the personas for tests and tools.'),
            volume_tag: DeclarationId.describe('Tag recorded with the fixture data on the volume.'), pagination_warning: DeclarationReason.describe('Warning shown with the fixtures about data beyond one page.'), provenance: Provenance.describe('Where the fixture setup came from.'),
            volume_operations: z.array(OverlayOperation).min(1).max(256).describe('Commands that write the fixtures to the volume.'), volume_probes: z.array(OverlayOperation).min(1).max(64).describe('Commands that check the fixtures are on the volume.'),
        }).strict().optional().describe('Fixture generation; required by a seeded mode.'),
        restore: z.object({
            rewrites: z.array(z.object({ category: DeclarationId.describe('Kind of sensitive data the rewrite covers.'), operation: OverlayOperation.describe('Command that performs the rewrite.'), reason: DeclarationReason.describe('Why the data needs rewriting.') }).strict()).max(256).describe('Commands that rewrite restored data so it is safe locally.'),
            untouched: z.array(DeclarationReason).min(1).max(256).describe('Restored data deliberately left as it is, with the reason for each.'), provenance: Provenance.describe('Where the restore handling came from.'),
        }).strict().optional().describe('Restore handling; required by, and only for, a restored mode.'),
    }).strict().optional().describe('Product data step for the stack; omit when there is none and up and reset skip it.'),
    vendors: z.array(VendorDeclaration).max(256).default([]).describe('Third-party vendors and how the stack handles each locally.'),
    // A structural subject without an entry is rendered as undecided rather than refused, so a
    // small stack does not have to invent a decision record to load.
    decisions: z.object({
        entries: DecisionEntries.default([]).describe('Decision records; a structure without one is shown as undecided.'),
    }).strict().prefault({}).describe('Recorded design decisions about the stack.'),
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
            if (mounts.length === 0 || mounts.some((mount) => mount.target !== mounts[0]!.target)) ctx.addIssue({ code: 'custom', path: ['volumes', index], message: 'dependency volume requires service mounts that share one target' })
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
        addressing: AddressingPosture.optional().describe('How the product is reached locally: by host name or by leased port.'),
        authentication: AuthPosture.optional().describe('How the product signs in locally: real sign-in, bypassed, or none.'),
        posture_requirements: z.array(PostureRequirement).min(1).max(128).optional().describe('Posture facts the product relies on, each tagged with the posture it depends on.'),
        machine: MachineFloor.optional().describe('Least the container runtime must offer before the stack starts.'),
        resettable_volumes: z.array(ResettableVolumeId).default([]).describe('Compose volumes that reset may delete and recreate, named by their Compose key.'),
        generated_host_paths: z.array(GeneratedHostPath).default([]).describe('Host paths cockpit generates and owns, relative to the cockpit.'),
        compose_files: z.array(LocalComposePath).default([]).describe('Existing Compose files, relative to the cockpit, that make up the stack; use this or generated.'),
        entrypoint_derivatives: z.array(EntrypointDerivative).default([]).describe('Addresses derived from leased ports, such as application origins and callback URLs.'),
        install_policies: z.array(InstallPolicy).default([]).describe('How dependencies are installed for each toolchain.'),
        generated: GeneratedEnvironment.optional().describe('Stack that cockpit generates instead of using existing Compose files; use this or compose_files.'),
    })
    .strict()
    .superRefine((environment, ctx) => {
        const identities = {
            resettable_volumes: environment.resettable_volumes,
            generated_host_paths: environment.generated_host_paths,
            compose_files: environment.compose_files,
            entrypoint_derivatives: environment.entrypoint_derivatives.map((row) => row.name),
            install_policies: environment.install_policies.map((row) => row.volume),
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
    service: GeneratedService.omit({ id: true, sibling: true, mounts: true, profiles: true }).describe('Generated service that runs this sibling\'s checkout.'),
    // The checkout is the sibling directory itself, bind-mounted as a directory at this target.
    checkout_mount: z.object({
        target: ContainerPath.describe('Absolute path inside the container where the checkout is mounted.'),
    }).strict().describe('Mount of the sibling checkout into the service.'),
    additional_mounts: GeneratedService.shape.mounts.optional().default([]).describe('Extra mounts for the service beyond the checkout.'),
    port_defaults: z.record(EnvironmentName, z.number().int().min(1).max(65535)).refine(
        (ports) => Object.keys(ports).length <= STRUCTURED_INPUT_ENTRY_LIMIT,
        `port defaults must not exceed ${STRUCTURED_INPUT_ENTRY_LIMIT} entries`,
    ).describe('Default host port for each of the service\'s host variables.'),
    entrypoints: z.array(EntrypointDerivative).max(256).describe('Addresses derived from this service\'s ports.'),
    volumes: GeneratedVolumes.optional().describe('Named volumes this row adds to the stack.'),
    install_policies: z.array(InstallPolicy).max(256).optional().describe('Install policies this row adds to the stack.'),
    decisions: DecisionEntries.min(1).describe('Decision records for the structure this row adds.'),
    provenance: Provenance.describe('Where this row\'s declaration came from.'),
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
    // A JSON file with a top-level `mcpServers` object, the shape agent tools read from `.mcp.json`.
    path: SafeRelativePath.max(4096).describe('JSON file in the sibling with a top-level mcpServers object, as agent tools read from .mcp.json.'),
    provenance: Provenance.describe('Where this MCP source declaration came from.'),
}).strict()

const SiblingDerives = z.object({
    generated: SiblingGeneratedDerivation.optional().describe('Generated-stack rows this sibling contributes.'),
    mcp_sources: z.array(McpSourceReference).max(256).default([]).describe('MCP server declaration files this sibling publishes.'),
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

// Runtime supplies sibling variables to Compose, so declarations must never overlap variables
// that can change Docker, Compose or the host process before cockpit's authenticated plan runs.
export const SiblingVariable = z.string().regex(
    /^(?!(?:DOCKER_|COMPOSE_|LD_|DYLD_|LIBPATH$|SHLIB_PATH$|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|PATH$|IFS$))[A-Z][A-Z0-9_]*$/,
    'expected an uppercase environment variable that is not a Docker, Compose or host process control',
)

export function deriveSiblingVariable(slug: string): string {
    const candidate = `${slug.toUpperCase().replaceAll('-', '_')}_DIR`
    return SiblingVariable.safeParse(candidate).success ? candidate : `SIBLING_${candidate}`
}

// Most repositories publish one or both of these, so an absent default guide is not an error; any
// other declared name is one the row chose, and an absent one is a typo that would copy nothing.
export const SIBLING_DEFAULT_GUIDES: readonly string[] = Object.freeze(['CLAUDE.md', 'AGENTS.md'])

export const Sibling = z
    .object({
        // Recorded rather than derived: slug, directory and remote are routinely three different
        // names for one repository, and every one of them is load-bearing somewhere.
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('Short name of the sibling; also how the root AGENTS.md labels its copied guides.'),
        // Relative to the siblings root and resolved without further checks by several
        // consumers, so the schema is where a hostile cockpit.toml is stopped. `.` is the
        // siblings root itself: a single-repository stack whose one sibling is the cockpit root, or a
        // cockpit started before any product repository exists, which grows with `sibling add`.
        dir: z.union([z.literal('.'), SafeRelativePath]).describe('Checkout directory under the siblings root, or . for the siblings root itself.'),
        // Absent exactly when nothing is cloned. Never derived from `dir`: a directory is
        // named for local convenience, a remote for whatever the org called it.
        remote: z.string().min(1).optional().describe('Git remote to clone from; required when acquire is auto or manual and not allowed when none.'),
        branch: z.string().min(1).optional().describe('Branch to check out when cloning.'),
        mount: Mount.describe('How the stack uses the checkout: always mounted, mounted under a profile, host only, or not mounted.'),
        acquire: Acquire.describe('How the checkout reaches disk: cloned by setup, cloned by a person, or not a repository.'),
        // The exported `*_DIR`. Recorded because it does not follow from the slug — a
        // `renderer` sibling may export ENGINE_DIR, and deriving RENDERER_DIR instead would
        // leave every consumer reading an unset variable.
        var: SiblingVariable.describe('Name of the exported *_DIR environment variable that points at the checkout.'),
        toolchain: Toolchain.default('none').describe('Toolchain that installs and tests the sibling; none for a directory of data.'),
        gate: Gate.optional().describe('Set to operator for a lane that touches live data or local hardware; it never runs by default and asks first.'),
        // Why this repository cannot join the stack. Required on a host lane, because that
        // is a constraint someone had to discover and it will otherwise be rediscovered as a
        // bug: a simulator that cannot be containerised, a renderer that lives in a vendor's
        // cloud, a client that needs a display. Preflight prints this instead of reporting
        // the sibling broken.
        host_reason: z.string().min(1).optional().describe('Why the sibling cannot join the stack; required when mount is host.'),
        // Which guide files this repository publishes. Projected into the cockpit as symlinks
        // to the live files — never copies, which are stale the moment the sibling edits its
        // own guide and report nothing. Defaulted rather than required: most repositories use
        // one or both of these, and one that does not is a row that says so.
        guides: z.array(SafeRelativePath).default([...SIBLING_DEFAULT_GUIDES]).describe('Guide files the sibling publishes, copied into the cockpit\'s root AGENTS.md by sync.'),
        // Setup writes this repository only when the declaration and its command-line approval agree.
        instruction_pointer: z.boolean().default(false).describe('Let setup add a pointer to the cockpit guide in this sibling, when the command line also approves it.'),
        // Printed when the checkout is missing, so it says what the absence costs.
        purpose: z.string().min(1).describe('What the sibling is for; printed when its checkout is missing.'),
        environment_files: z.array(EnvironmentFile).optional().describe('Template and instance environment file pairs the sibling needs.'),
        derives: SiblingDerives.optional().describe('Facts about the sibling that cockpit derives rows or MCP servers from.'),
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
        step: z.number().int().positive().default(100).describe('Offset between consecutive stacks\' published ports.'),
        count: z.number().int().positive().default(27).describe('Number of stacks that can run side by side.'),
        bases: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.number().int().min(1).max(65535)).describe('Base host port for each port variable; stack n publishes base plus n times step.'),
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
    argv: GuardCommandArgv.describe('Command prefix, as an argument list, that is allowed.'),
    reason: GuardRuleText.describe('Why the command is allowed.'),
    cwd: z.union([z.literal('.'), SafeRelativePath.max(4096)]).optional().describe('Allow only when run from this directory, relative to the cockpit.'),
}).strict()
const GuardDeny = z.union([
    z.object({ prefix: GuardCommandArgv.describe('Command prefix, as an argument list, that is refused.'), reason: GuardRuleText.describe('Why the command is refused.'), fix: GuardRuleText.optional().describe('Safer command or step to suggest instead.') }).strict(),
    z.object({ contains: GuardCommandArgv.describe('Argument sequence that is refused wherever it appears in a command.'), reason: GuardRuleText.describe('Why the command is refused.'), fix: GuardRuleText.optional().describe('Safer command or step to suggest instead.') }).strict(),
])

export const Guards = z
    .object({
        hosted_db_hosts: GuardHosts.default([]).describe('Hosted database host names the guards keep agents away from.'),
        vendor_endpoint_hosts: GuardHosts.default([]).describe('Real vendor endpoint host names the guards keep agents away from.'),
        protected_branches: z.array(z.string()).default(['main', 'master']).describe('Branches the guards keep agents from pushing to or rewriting.'),
        allow: z.array(GuardAllow).max(64).default([]).describe('Commands allowed in addition to the built-in rules.'),
        deny: z.array(GuardDeny).max(64).default([]).describe('Commands refused in addition to the built-in rules.'),
    })
    .strict()

// THE approval list: each approved server name maps to the digest of the declaration a human
// reviewed, which `sync` reports for every server it keeps disabled. Approving a name alone let an
// agent rewrite the command of an approved server in a sibling's declaration file and the next
// human sync start it. A server absent from it, or changed since, is generated disabled on every
// harness, so the three cannot disagree about what may start.
export const Mcp = z
    .object({
        approved: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).max(128), z.string().regex(/^[a-f0-9]{64}$/, 'an approval is the sha256 sync reports for the server'))
            .refine((approved) => Object.keys(approved).length <= 256, 'at most 256 MCP servers can be approved').default({}).describe('Approved MCP servers, each mapped to the sha256 of the declaration a person reviewed; others stay disabled.'),
    })
    .strict()

// A whole product suite under a build tool runs for minutes, not seconds; the ceiling still bounds
// a hung stage so a gate always returns a verdict. Work-order verification runs the same suites.
const TESTING_STAGE_TIMEOUT_DEFAULT_SECONDS = 1_800
export const TESTING_STAGE_TIMEOUT_MAX_SECONDS = 7_200
// One independent review or grading run of the evaluator reads the change and reruns checks; minutes
// are normal, and each of the four runs gets its own budget rather than sharing one.
const EVALUATOR_TIMEOUT_DEFAULT_SECONDS = 900
// The agent tools that can run headless with a read-only mechanism of their own and return output a
// schema constrains, named as the harness registry names them, each with the command it runs as.
export const EVALUATOR_COMMANDS = Object.freeze({ codexcli: 'codex', claudecode: 'claude', opencode: 'opencode' } as const)
export type EvaluatorTool = keyof typeof EVALUATOR_COMMANDS

export const Workorders = z
    .object({
        // Consumers may lower the repeated-failure limit, never raise it.
        attempt_cap: z.number().int().min(1).max(2).default(2).describe('Repeated failures allowed before a work order stops; may be lowered but not raised.'),
        // Consumer values may lower these framework maxima, but cannot raise them.
        wip_cap: z.number().int().min(1).max(3).default(3).describe('Work orders that may be in progress at once; may be lowered but not raised.'),
        verification_timeout_seconds: z.number().int().min(1).max(TESTING_STAGE_TIMEOUT_MAX_SECONDS).default(TESTING_STAGE_TIMEOUT_DEFAULT_SECONDS)
            .describe('Seconds one declared work-order verification command may run before it is stopped and reported as not run.'),
        evaluator_timeout_seconds: z.number().int().min(1).max(TESTING_STAGE_TIMEOUT_MAX_SECONDS).default(EVALUATOR_TIMEOUT_DEFAULT_SECONDS)
            .describe('Seconds one independent review or grading run of the evaluator may take before it is stopped.'),
        // An ordered fallback list: the first that runs answers, and one that is missing, signed out or
        // rate-limited is recorded and passed over. It never falls back to the agent grading itself.
        evaluators: z.array(z.enum(['codexcli', 'claudecode', 'opencode'] as const satisfies readonly EvaluatorTool[])).min(1).max(3)
            .refine(tools => new Set(tools).size === tools.length, 'list each evaluator once').default(['codexcli', 'claudecode', 'opencode'])
            .describe('Agent tools that run the independent reviewers and grader for work review and work grade, tried in order: codexcli, claudecode, opencode.'),
    })
    .strict()

// An exact semantic version, pre-release included: an MCP image can bundle a Playwright alpha.
export const BROWSER_DRIVER_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/
const BrowserDriverVersion = z.string().max(128).regex(BROWSER_DRIVER_VERSION)

/** Playwright refuses a client and server whose major.minor differ, so only that much must agree. */
export function browserDriversCompatible(left: string, right: string): boolean {
    const release = (version: string) => version.split('-', 1)[0]!.split('.').slice(0, 2).join('.')
    return release(left) === release(right)
}

const BrowserImage = z.object({
    reference: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/).describe('Image reference pinned by sha256 digest.'),
    driver_version: BrowserDriverVersion.describe('Playwright driver version the image carries.'),
}).strict()

const BrowserArtifactRoots = z.object({
    runner: GeneratedHostPath.describe('Generated host path for the browser runner\'s files.'),
    mcp: GeneratedHostPath.describe('Generated host path for the browser MCP server\'s files.'),
    cli: GeneratedHostPath.describe('Generated host path for command-line browser output.'),
    auth: GeneratedHostPath.describe('Generated host path for saved sign-in state.'),
    debugger: GeneratedHostPath.describe('Generated host path for debugger sessions.'),
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
    engine: z.enum(['chromium', 'firefox', 'webkit']).default('chromium').describe('Browser engine to drive.'),
    network_exposure: z.string().min(1).max(512).regex(/^[a-z0-9.*:<>\[\],-]+$/).refine((value) => {
        const rules = value.split(',')
        return rules.length <= 32 && rules.every((rule) => rule.length > 0) && new Set(rules).size === rules.length
    }, 'browser network exposure requires bounded unique rules').default('<loopback>').describe('Network rules the browser may reach beyond loopback; the default is loopback only.'),
    network_exposure_reason: z.string().min(1).max(512).refine((value) => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value), 'browser exposure reason must be bounded plain text').optional().describe('Why the browser needs wider network access; required when network_exposure is wider than loopback.'),
    harnesses: z.array(z.object({
        target: z.enum(GUARD_SURFACE_TARGETS).describe('Agent tool the browser is wired to.'),
        version: z.string().regex(/^\d+\.\d+\.\d+$/).describe('Version of the agent tool the wiring was checked against.'),
    }).strict()).min(1).max(GUARD_SURFACE_TARGETS.length).refine(
        (rows) => !hasDuplicate(rows.map((row) => row.target)),
        'browser harness targets must be unique',
    ).describe('Agent tools, with versions, that are wired to the browser.'),
    images: z.object({ runner: BrowserImage.extend({ architectures: z.array(z.enum(['amd64', 'arm64'])).min(1).max(2).refine((values) => !hasDuplicate(values), 'browser image architectures must be unique').optional().describe('CPU architectures the runner image must support.') }).describe('Image that runs the browser.'), mcp: BrowserImage.describe('Image that serves the browser MCP server.') }).strict().describe('Pinned container images for the browser.'),
    runner_health_measurement: HealthMeasurement.optional().describe('Measured time for the browser runner to become healthy.'),
    resources: GeneratedService.shape.resources.describe('Memory and CPU ceilings for the browser runner.'),
    project: z.object({
        manifest: GeneratedHostPath.optional().describe('package.json for the project; omit to use the one beside the lockfile.'),
        manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('SHA-256 of the manifest; required when manifest is set.'),
        lockfile: GeneratedHostPath.describe('Lockfile the runner installs from.'),
        sha256: z.string().regex(/^[a-f0-9]{64}$/).describe('SHA-256 of the lockfile.'),
        driver_version: BrowserDriverVersion.describe('Playwright driver version the lockfile pins.'),
    }).strict().describe('Node project the runner installs its driver from.'),
    endpoint: z.string().url().optional().describe('WebSocket address of the browser server, using an allowed host.'),
    max_clients: z.number().int().min(1).max(64).describe('Most browser clients that may connect at once.'),
    proxy: z.object({
        host_variable: EnvironmentName.optional().describe('Port variable in [ports.bases] that leases the proxy port.'),
        server_port: z.number().int().min(1).max(65535).describe('Port the browser server listens on.'),
        proxy_port: z.number().int().min(1).max(65535).describe('Port the proxy listens on; differs from server_port.'),
        allowed_hosts: z.array(z.string().min(1).max(260)).min(1).max(64).describe('Host and port pairs the proxy allows.'),
        bind: z.enum(['127.0.0.1', '::1']).default('127.0.0.1').describe('Loopback address the proxy binds to.'),
    }).strict().describe('Proxy the browser reaches the application through.'),
    resolver: z.array(z.object({
        hostname: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/).describe('Host name to resolve.'),
        address: z.union([z.ipv4(), z.ipv6()]).describe('Address the host name resolves to.'),
    }).strict()).max(64).default([]).describe('Fixed host name to address mappings the browser uses.'),
    authentication: z.object({
        policy: z.enum(['none', 'serialized', 'per-worker']).describe('Whether sessions share no sign-in, take turns on one, or each keep their own.'),
        states: z.array(z.object({
            worker: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe('Name of the worker the state belongs to.'),
            path: GeneratedHostPath.describe('Saved sign-in state file under the auth artifact root.'),
        }).strict()).max(64).default([]).describe('Saved sign-in states, one per worker.'),
    }).strict().describe('How browser sessions sign in to the application.'),
    // `isolated` and `reaches_production` are the person's statement about the data the browser
    // touches; cockpit cannot observe either. They are required rather than defaulted so that
    // request_preapproval, which lets browser tools run without prompts, is never granted on a
    // posture nobody wrote down.
    data: z.object({
        mode: DataMode.describe('Data mode the stack runs in while the browser is used.'),
        isolated: z.boolean().describe('True when the data is separate from anyone else\'s.'),
        reaches_production: z.boolean().describe('True when browser actions can affect production.'),
    }).strict().describe('Statement about the data the browser touches; cockpit cannot observe it.'),
    request_preapproval: z.boolean().default(false).describe('Run browser tools without prompts; allowed only on isolated, non-production, non-restored data.'),
    headed: z.boolean().default(false).describe('Show the browser window instead of running it headless.'),
    artifacts: BrowserArtifactRoots.describe('Generated host paths for browser output.'),
}).strict().superRefine((browser, ctx) => {
    if (browser.resources && !browser.endpoint) {
        ctx.addIssue({ code: 'custom', path: ['resources'], message: 'browser resource ceilings require a generated runner endpoint' })
    }
    try {
        parseBrowserNetworkExposure(browser.network_exposure, browser.network_exposure_reason)
    } catch (error) {
        ctx.addIssue({ code: 'custom', path: ['network_exposure'], message: errorCause(error) })
    }
    if ((browser.project.manifest === undefined) !== (browser.project.manifest_sha256 === undefined)) {
        ctx.addIssue({ code: 'custom', path: ['project'], message: 'browser project manifest path and digest must be declared together' })
    }
    // The runner installs the project's lockfile, so the two pin one driver exactly.
    if (browser.images.runner.driver_version !== browser.project.driver_version) {
        ctx.addIssue({ code: 'custom', path: ['images', 'runner', 'driver_version'], message: 'browser runner image and project driver versions must match exactly' })
    }
    if (!browserDriversCompatible(browser.images.mcp.driver_version, browser.project.driver_version)) {
        ctx.addIssue({ code: 'custom', path: ['images', 'mcp', 'driver_version'], message: 'browser MCP image driver must share major.minor with the project driver' })
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
        } catch { /* The issue names the rule; URL parser text adds nothing. */ ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'browser endpoint must use an allowed credential-free ws:// authority; TLS termination is unavailable' }) }
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

export const TestingName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const TestingCommand = z.array(z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value))).min(1).max(128)
// Stock runners reject an unknown option, so a selection reaches a stage only through arguments the
// stage declares in its tool's own spelling, such as ["-t", "{value}"] for vitest or ["-k", "{value}"] for pytest.
const TestingSelectArguments = z.array(z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value))).min(1).max(32)
    .refine((values) => values.some((value) => value.includes('{value}')), 'a selection must place {value} in at least one argument')
const TestingSelect = z.object({
    spec: TestingSelectArguments.optional().describe('Arguments that select tests by spec; {value} becomes the selection.'),
    file: TestingSelectArguments.optional().describe('Arguments that select tests by file; {value} becomes the selection.'),
    test: TestingSelectArguments.optional().describe('Arguments that select tests by test name; {value} becomes the selection.'),
    route: TestingSelectArguments.optional().describe('Arguments that select tests by route; {value} becomes the selection.'),
}).strict()
export const Testing = z.object({
    stages: z.array(z.object({
        id: TestingName.describe('Name of the stage.'),
        command: TestingCommand.describe('Command to run, as an argument list.'),
        requires_stack: z.boolean().describe('True when the stage needs the stack running.'),
        timeout_seconds: z.number().int().min(1).max(TESTING_STAGE_TIMEOUT_MAX_SECONDS).default(TESTING_STAGE_TIMEOUT_DEFAULT_SECONDS)
            .describe('Seconds the stage may run before it is stopped and the gate reports DEGRADED.'),
        select: TestingSelect.optional()
            .describe('Arguments appended to the command when test-run --select names that kind; {value} becomes the selected value.'),
    }).strict()).min(1).max(128).describe('Commands that make up the test gates.'),
    gates: z.array(z.object({
        id: TestingName.describe('Name of the gate.'),
        tier: z.enum(['targeted', 'full']).describe('Whether the gate covers targeted changes or the full suite.'),
        stages: z.array(TestingName).min(1).max(128).describe('Stages the gate runs, by id.'),
        changes: z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value)).describe('Kind of change that calls for this gate.'),
    }).strict()).min(1).max(128).describe('Named gates that run stages before handing back changes.'),
    native_hooks: z.object({
        install: z.enum(['inspect', 'explicit-native']).default('inspect').describe('Inspect the repository\'s hooks, or install them as the policy file declares.'),
    }).strict().default({ install: 'inspect' }).describe('How the repository\'s own git hooks are handled.'),
    native_hook_policy: z.object({
        path: SafeRelativePath.max(4096).describe('Policy file, relative to the cockpit.'),
        sha256: z.string().regex(/^[a-f0-9]{64}$/).describe('SHA-256 of the policy file.'),
    }).strict().optional().describe('Policy file for installing the repository\'s hooks; required for explicit-native.'),
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
        name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('Name of this cockpit.'),
        // Resolved from the MAIN checkout, never from the cwd's parent — a nested linked
        // checkout must still find the declared sibling root.
        siblings_root: z.string().default('..').describe('Directory holding the sibling checkouts, relative to the cockpit.'),
        // preflight FAILS over it. A cap that only warns is a cap that is always slightly
        // exceeded; adherence falls as the guide grows.
        guide_cap: z.number().int().positive().default(200).describe('Most lines of always-loaded guidance; preflight fails above it.'),
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
    } catch { return false } // The caller reports front matter that is not plain YAML; parser text would quote the file.
}

export const SurfaceSource = z.object({
    path: SurfacePath.describe('Path of the source file.'),
    bytes: SurfaceBytes.describe('Full text of the source.'),
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
    name: SurfaceName.describe('Name of the core declaration being replaced.'),
    sha256: SurfaceSha256.describe('SHA-256 of the original core declaration, recorded so a later change to it is reported.'),
}).strict()

export const SurfaceDeclaration = z.object({
    name: SurfaceName.describe('Name of the declaration; an overlay that reuses a core name replaces it.'),
    feature: z.enum(SURFACE_FEATURES).describe('Kind of surface the declaration provides.'),
    sources: z.array(SurfaceSource).min(1).max(256).describe('Files that make up the declaration.'),
    source: SurfacePath.describe('Where the declaration was read from.'),
    replaces: SurfaceOverrideReference.optional().describe('Core declaration this overlay replaces; required when the name matches a core one.'),
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
    feature: z.enum(['rules', 'subagents', 'skills', 'hooks']).describe('Kind of surface the overlay provides.'),
})

// A team's own harness settings file that cockpit moved under cockpit/adopted/ and merges with its
// rendering. `sha256` records the bytes that were moved; it is a record for review, not a lock:
// the adopted copy is consumer-owned, and the next sync re-merges whatever it holds.
export const SurfaceAdoption = z.object({
    path: z.enum(ADOPTABLE_SURFACE_PATHS).describe('Harness settings file that was adopted.'),
    source: SurfacePath.describe('Where the adopted copy now lives, under cockpit/adopted/.'),
    sha256: SurfaceSha256.describe('SHA-256 of the bytes that were moved, as a record for review.'),
    adopted_on: z.string().date().describe('Date the file was adopted.'),
    provenance: Provenance.describe('Where the adoption came from; its kind must be declared.'),
}).strict().superRefine((row, ctx) => {
    if (row.source !== `${ADOPTED_SURFACE_ROOT}/${row.path}`) {
        ctx.addIssue({ code: 'custom', path: ['source'], message: `an adopted surface is kept at ${ADOPTED_SURFACE_ROOT}/<path>` })
    }
    if (row.provenance.kind !== 'declared') {
        ctx.addIssue({ code: 'custom', path: ['provenance', 'kind'], message: 'an adopted surface is declared by the team that owns it' })
    }
})

const HarnessMechanism = z.object({
    module: SurfacePath.describe('Module that implements the capability.'),
    export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).max(128).describe('Export of the module that implements the capability.'),
}).strict()

const HarnessCapabilityBase = {
    feature: z.enum(SURFACE_FEATURES).describe('Surface feature this row describes.'),
    measured_on: z.string().date().describe('Date the capability was measured.'),
} as const

const HarnessEmittedCapability = {
    ...HarnessCapabilityBase,
    spelling: SurfacePath.describe('File the harness reads for this feature.'),
    control: SurfacePath.describe('Path of the deliberately broken control file the capability was measured against.'),
    mechanism: HarnessMechanism.describe('Code that emits the surface.'),
} as const

export const CustomHarnessCapability = z.discriminatedUnion('state', [
    z.object({
        ...HarnessEmittedCapability,
        state: z.literal('enforced').describe('Whether the harness enforces, only instructs, or lacks this capability.'),
        evidence: z.object({ reference: SurfacePath.describe('Probe record or file, relative to the cockpit.'), sha256: SurfaceSha256.describe('SHA-256 of the evidence.') }).strict().describe('Evidence that the harness enforces the capability.'),
    }).strict(),
    z.object({
        ...HarnessEmittedCapability,
        state: z.literal('instructed').describe('Whether the harness enforces, only instructs, or lacks this capability.'),
    }).strict(),
    z.object({
        ...HarnessCapabilityBase,
        state: z.literal('unavailable').describe('Whether the harness enforces, only instructs, or lacks this capability.'),
        reason: DeclarationReason.describe('Why the capability is unavailable.'),
    }).strict(),
])

export const CustomHarness = z.object({
    name: SurfaceName.regex(new RegExp(`^(?!(?:${SURFACE_TARGETS.join('|')})$)`), 'custom harness names cannot replace shipped targets').describe('Name of the custom harness; cannot reuse a shipped one.'),
    capabilities: z.array(CustomHarnessCapability).length(SURFACE_FEATURES.length).describe('One row per surface feature saying what the harness supports.'),
}).strict().superRefine((harness, ctx) => {
    const features = harness.capabilities.map((capability) => capability.feature)
    if (hasDuplicate(features) || SURFACE_FEATURES.some((feature) => !features.includes(feature))) {
        ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'capabilities must hold exactly one row for each surface feature' })
    }
    const spellings = harness.capabilities.flatMap((capability) => capability.state === 'unavailable' ? [] : [capability.spelling])
    if (hasDuplicate(spellings)) {
        ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'emitted capability spellings must be unique' })
    }
})

export const Surfaces = z.object({
    overlays: z.array(SurfaceOverlay).max(256).default([]).describe('Team-owned rules, subagents, skills and hooks added to the generated surfaces.'),
    harnesses: z.array(CustomHarness).max(64).default([]).describe('Agent tools beyond the shipped ones, with measured capabilities.'),
    bundles: z.array(z.enum(SURFACE_BUNDLE_FORMATS)).max(SURFACE_BUNDLE_FORMATS.length).default([]).describe('Bundle formats to publish, such as a Claude plugin bundle.'),
    adopted: z.array(SurfaceAdoption).max(ADOPTABLE_SURFACE_PATHS.length).default([]).describe('Harness settings files cockpit merges with its own output.'),
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

/**
 * The init interview answers a cockpit.toml records. `unconfirmed` lists those no person stated: the
 * setup agent chose them as defaults, or the answers file did not say who chose them. doctor warns
 * until a person confirms each one and deletes its entry, because a configuration whose values look
 * stated but were guessed is the failure cockpit exists to prevent.
 */
export const UNCONFIRMABLE_ANSWERS = ['cockpit.name', 'sibling', 'estate.runnable', 'ports.bases', 'environment.install_policies',
    'environment.test_data', 'environment.generated', 'environment.compose_files', 'environment.machine', 'environment.posture',
    'testing', 'guards'] as const

export const CockpitConfig = z
    .object({
        unconfirmed: z.array(z.enum(UNCONFIRMABLE_ANSWERS)).min(1).max(UNCONFIRMABLE_ANSWERS.length)
            .refine(rows => new Set(rows).size === rows.length, { message: 'unconfirmed lists an answer more than once' }).optional().describe('Answers no person has stated yet; init writes them and doctor reports them.'),
        cockpit: CockpitMeta.describe('Identity and layout of this cockpit.'),
        sibling: z.array(Sibling).min(1).describe('Product repositories the cockpit works across.'),
        ports: Ports.describe('Port leasing for running stacks side by side.'),
        guards: Guards.prefault({}).describe('Rules that restrict what agents may run.'),
        mcp: Mcp.prefault({}).describe('Approval of MCP servers.'),
        workorders: Workorders.prefault({}).describe('Limits for work orders.'),
        browser: Browser.optional().describe('Browser automation for the stack.'),
        testing: Testing.optional().describe('Test stages and gates.'),
        environment: Environment.prefault({}).describe('How the stack is reached, signed in to, built and kept.'),
        surfaces: Surfaces.prefault({}).describe('Instructions, skills and settings generated for agent tools.'),
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
                // A stack with no sign-in has no requirement that depends on one, so the row may leave it untagged.
                if (!cfg.environment.posture_requirements.some((row) => row.addressing === cfg.environment.addressing
                    && (row.authentication === cfg.environment.authentication
                        || cfg.environment.authentication === 'none' && row.authentication === undefined))) {
                    ctx.addIssue({ code: 'custom', path: ['browser'], message: 'browser posture requirements must cover the selected environment declarations' })
                }
                if (cfg.environment.addressing === 'hostname' && cfg.browser.resolver.length === 0
                    || cfg.environment.addressing === 'port' && cfg.browser.resolver.length !== 0) {
                    ctx.addIssue({ code: 'custom', path: ['browser', 'resolver'], message: 'browser resolver declarations must match the environment addressing posture' })
                }
                const { policy, states } = cfg.browser.authentication
                if (cfg.environment.authentication !== 'real' && (policy !== 'none' || states.length !== 0)
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
        // Reset matches each entry against a Compose volume key, so a name no volume declares
        // would reset nothing while reading as a control. A compose-first stack's keys live in its
        // Compose files and are checked where `sync`, `check` and `up` read them.
        if (globalGenerated !== undefined || cfg.environment.compose_files.length === 0) {
            const declared = [
                ...(globalGenerated?.volumes ?? []).map(({ id }) => id),
                ...generatedRows.flatMap(({ generated }) => (generated.volumes ?? []).map(({ id }) => id)),
            ]
            cfg.environment.resettable_volumes.forEach((name, index) => {
                if (declared.includes(name)) return
                ctx.addIssue({
                    code: 'custom', path: ['environment', 'resettable_volumes', index],
                    message: globalGenerated === undefined
                        ? `resettable volume ${JSON.stringify(name)} names no volume: the environment declares neither generated volumes nor compose_files`
                        : `resettable volume ${JSON.stringify(name)} is not a generated volume id${declared.length === 0 ? '' : ` (declared: ${declared.join(', ')})`}`,
                })
            })
        }
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

// How a sibling is described, fetched, gated for agents or projected into guides. None of it reaches
// a container, so editing it must leave a running stack alone.
const SIBLING_NON_RUNTIME_FIELDS: ReadonlySet<string> = new Set(['purpose', 'guides', 'instruction_pointer', 'remote', 'branch', 'acquire', 'host_reason', 'gate'])

// What the host checks or reports around the containers: the machine floor and cold-start budget
// `up` and preflight hold the host to, the posture preflight reads, the volumes `reset` may delete,
// and the URLs derived from leased ports. Hashing them made raising cold_start_seconds strand a
// healthy stack behind a demand to run `down`.
const ENVIRONMENT_NON_RUNTIME_FIELDS: ReadonlySet<string> = new Set([
    'machine', 'addressing', 'authentication', 'posture_requirements', 'resettable_volumes', 'entrypoint_derivatives',
])

// What a declaration says to its reader: why it is so, where it came from, what a probe proves, how
// long a start once took. Rendering keeps all of it out of the Compose file and the work a running
// stack is bound to, so rewording a health property or a provenance note left a healthy stack
// behind a demand to run `down`.
const DESCRIPTIVE_FIELDS: ReadonlySet<string> = new Set(['provenance', 'reason', 'property', 'measurement', 'alternative'])

function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).filter(([key]) => !DESCRIPTIVE_FIELDS.has(key))
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
        : item)
}

function sortedBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
    return [...rows].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0)
}

// Decision records describe the stack, and the renderer sorts these tables by identity, so neither
// the records nor the order of the tables in cockpit.toml reaches a container.
function generatedRuntime({ decisions: _decisions, ...generated }: GeneratedEnvironment) {
    return {
        ...generated,
        services: sortedBy(generated.services, ({ id }) => id).map((service) => ({
            ...service,
            ports: sortedBy(service.ports, ({ name }) => name),
            mounts: sortedBy(service.mounts, ({ kind, source, target }) => `${kind}:${source}:${target}`),
            dependencies: sortedBy(service.dependencies, ({ service: dependency }) => dependency),
        })),
        volumes: sortedBy(generated.volumes, ({ id }) => id),
        vendors: sortedBy(generated.vendors, ({ id }) => id),
    }
}

/**
 * The SHA-256 that identifies a running stack: ownership labels, the generation, saved progress and
 * data history are keyed by it rather than by the bytes of cockpit.toml. Keying them by the file
 * meant rewording a sibling's purpose stranded the running stack, so `up` and `sibling add` refused
 * until it was torn down.
 *
 * It covers everything except what is known not to reach a container: comments and formatting,
 * guards, MCP, work orders, surfaces, testing, the guide settings, generated decision records, the
 * descriptive sibling fields, the host-only environment fields, siblings with mount "none" that no
 * generated service names, descriptive prose and provenance anywhere, and the order of the generated
 * tables the renderer sorts. A new field is therefore counted
 * as runtime until someone decides otherwise: the failure is a needless down, never a stack running
 * an older declaration than the one on disk. The contents of `environment.compose_files` are
 * outside it: only their paths are declared here, and `up` hands the files to Compose as they are.
 */
export function runtimeDeclarationSha256(cfg: CockpitConfig): string {
    const generated = cfg.environment.generated
    const servedSiblings = new Set(generated?.services.map(({ sibling }) => sibling) ?? [])
    const sibling = cfg.sibling
        .filter((row) => row.mount !== 'none' || servedSiblings.has(row.slug) || row.derives !== undefined || row.toolchain !== 'none')
        .map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => !SIBLING_NON_RUNTIME_FIELDS.has(field))))
        .sort((left, right) => String(left.slug) < String(right.slug) ? -1 : 1)
    const { generated: _generated, ...declared } = cfg.environment
    const environment = Object.fromEntries(Object.entries(declared).filter(([field]) => !ENVIRONMENT_NON_RUNTIME_FIELDS.has(field)))
    return createHash('sha256').update(canonicalJson({
        cockpit: { name: cfg.cockpit.name, siblings_root: cfg.cockpit.siblings_root },
        sibling,
        ports: cfg.ports,
        browser: cfg.browser ?? null,
        environment: { ...environment, generated: generated ? generatedRuntime(generated) : null },
    })).digest('hex')
}
