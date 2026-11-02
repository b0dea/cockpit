import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parse } from 'smol-toml'
import {
    ENVIRONMENT_CODES,
    type ConfigSourceSnapshot,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type RefusalCode,
    type SourceProvenance,
    snapshotJson,
} from '../environment/contract.js'
import { validateWorkOrderPolicy, type ValidatedWorkOrderPolicy } from '../work-orders/intake.js'
import { CockpitConfig, runtimeDeclarationSha256 } from '../schema.js'
import { formatShellCommand } from '../fix-catalogue.js'

export const mechanism = {
    id: 'configuration-loading',
    module: 'packages/cockpit/src/config/load.ts',
    exports: ['loadCockpitConfig', 'observeConfigSource', 'consumeLoadedConfigProjection', 'projectMachineFloorConfig', 'consumeMachineFloorConfigProjection', 'projectWorkEnvironmentConfig', 'consumeWorkEnvironmentConfigProjection', 'STRUCTURED_INPUT_BYTE_LIMIT', 'readBoundedInput', 'schemaIssueSummary'],
} as const

export const STRUCTURED_INPUT_BYTE_LIMIT = 1_048_576

export type BoundedInputRead =
    | Readonly<{ kind: 'complete'; bytes: Buffer }>
    | Readonly<{ kind: 'too-large' }>

export async function readBoundedInput(path: string): Promise<BoundedInputRead> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const opened = await file.stat()
        if (!opened.isFile()) throw Object.assign(new Error('structured input is not a regular file'), { code: 'EISDIR' })
        if (opened.size > STRUCTURED_INPUT_BYTE_LIMIT) return Object.freeze({ kind: 'too-large' })
        const buffer = Buffer.allocUnsafe(STRUCTURED_INPUT_BYTE_LIMIT + 1)
        let offset = 0
        while (offset < buffer.length) {
            const read = await file.read(buffer, offset, buffer.length - offset, offset)
            if (read.bytesRead === 0) break
            offset += read.bytesRead
        }
        if (offset > STRUCTURED_INPUT_BYTE_LIMIT) return Object.freeze({ kind: 'too-large' })
        const openedAfter = await file.stat()
        const namedAfter = await lstat(path)
        if (
            openedAfter.dev !== opened.dev || openedAfter.ino !== opened.ino
            || openedAfter.size !== opened.size || openedAfter.mtimeMs !== opened.mtimeMs || openedAfter.ctimeMs !== opened.ctimeMs
            || namedAfter.isSymbolicLink() || !namedAfter.isFile()
            || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino
            || namedAfter.size !== opened.size || namedAfter.mtimeMs !== opened.mtimeMs || namedAfter.ctimeMs !== opened.ctimeMs
            || offset !== opened.size
        ) throw Object.assign(new Error('structured input changed while reading'), { code: 'EIO' })
        return Object.freeze({ kind: 'complete', bytes: Buffer.from(buffer.subarray(0, offset)) })
    } finally {
        await file.close()
    }
}

declare const loadedConfigProjectionBrand: unique symbol
export type LoadedConfigProjection = LoadedCockpitConfig

export interface ConsumedLoadedConfig {
    readonly config: CockpitConfig
    readonly source: SourceProvenance
    /** Identifies the stack this configuration runs; `source.sha256` identifies the file that was read. */
    readonly runtimeSha256: string
    readonly guardHostsStated: boolean
}

export interface LoadedCockpitConfig {
    readonly config: CockpitConfig
    readonly source: SourceProvenance
    /** Identifies the stack this configuration runs; `source.sha256` identifies the file that was read. */
    readonly runtimeSha256: string
    /**
     * Both guard host keys are written in the file. The schema defaults an absent key to the same
     * empty list, so only the parsed source can tell "none exists" from "never answered".
     */
    readonly guardHostsStated: boolean
    readonly [loadedConfigProjectionBrand]: never
}

const issuedConfigProjections = new WeakMap<object, ConsumedLoadedConfig>()

export interface MachineFloorConfigProjection { readonly kind: 'machine-floor-config-projection' }
export interface ConsumedMachineFloorConfig {
    readonly cockpitName: string
    readonly source: SourceProvenance
    readonly runtimeSha256: string
    readonly floor: Readonly<{ runtimeMemoryMb: number; runtimeCpus: number; freeDiskMb: number }>
}
const issuedMachineFloorConfigProjections = new WeakMap<object, ConsumedMachineFloorConfig>()

export interface WorkEnvironmentConfigProjection { readonly kind: 'work-environment-config-projection' }
export interface ConsumedWorkEnvironmentConfig {
    readonly cockpitName: string
    readonly cockpitRoot: string
    readonly siblingsRoot: string
    readonly source: SourceProvenance
    readonly siblings: readonly Readonly<{ slug: string; dir: string; environmentFiles: readonly Readonly<{ template: string; instance: string }>[] }>[]
    readonly workOrderPolicy: ValidatedWorkOrderPolicy
    readonly generatedHostPaths: readonly string[]
    readonly browser?: ReturnType<typeof projectBrowserConfig>
    readonly testing?: ReturnType<typeof projectTestingConfig>
}
const issuedWorkEnvironmentConfigProjections = new WeakMap<object, ConsumedWorkEnvironmentConfig>()

function projectBrowserConfig(declaredBrowser: NonNullable<CockpitConfig['browser']>) {
    return Object.freeze({
        engine: declaredBrowser.engine,
        ...(declaredBrowser.resources === undefined ? {} : { resources: Object.freeze({
            memory_mb: declaredBrowser.resources.memory_mb, cpus: declaredBrowser.resources.cpus,
            provenance: Object.freeze({ ...declaredBrowser.resources.provenance }),
        }) }),
        networkExposure: declaredBrowser.network_exposure,
        ...(declaredBrowser.network_exposure_reason === undefined ? {} : { networkExposureReason: declaredBrowser.network_exposure_reason }),
        harnesses: Object.freeze(declaredBrowser.harnesses.map((row) => Object.freeze({ ...row }))),
        images: Object.freeze({
            runner: Object.freeze({ reference: declaredBrowser.images.runner.reference, driverVersion: declaredBrowser.images.runner.driver_version,
                ...(declaredBrowser.images.runner.architectures === undefined ? {} : { architectures: Object.freeze([...declaredBrowser.images.runner.architectures]) }) }),
            mcp: Object.freeze({ reference: declaredBrowser.images.mcp.reference, driverVersion: declaredBrowser.images.mcp.driver_version }),
        }),
        ...(declaredBrowser.runner_health_measurement === undefined ? {} : { runnerHealthMeasurement: Object.freeze({
            duration_seconds: declaredBrowser.runner_health_measurement.duration_seconds,
            provenance: Object.freeze({ ...declaredBrowser.runner_health_measurement.provenance }),
        }) }),
        project: Object.freeze({ lockfile: declaredBrowser.project.lockfile, sha256: declaredBrowser.project.sha256, driverVersion: declaredBrowser.project.driver_version,
            ...(declaredBrowser.project.manifest === undefined ? {} : { manifest: declaredBrowser.project.manifest, manifestSha256: declaredBrowser.project.manifest_sha256! }) }),
        ...(declaredBrowser.endpoint === undefined ? {} : { endpoint: declaredBrowser.endpoint }),
        maxClients: declaredBrowser.max_clients,
        proxy: Object.freeze({
            ...(declaredBrowser.proxy.host_variable === undefined ? {} : { hostVariable: declaredBrowser.proxy.host_variable }),
            serverPort: declaredBrowser.proxy.server_port,
            proxyPort: declaredBrowser.proxy.proxy_port,
            allowedHosts: Object.freeze([...declaredBrowser.proxy.allowed_hosts]),
            bind: declaredBrowser.proxy.bind,
            directServerPublish: false,
        }),
        resolver: Object.freeze(declaredBrowser.resolver.map((row) => Object.freeze({ ...row }))),
        authentication: Object.freeze({
            policy: declaredBrowser.authentication.policy,
            states: Object.freeze(declaredBrowser.authentication.states.map((row) => Object.freeze({ ...row }))),
        }),
        data: Object.freeze({
            mode: declaredBrowser.data.mode,
            isolated: declaredBrowser.data.isolated,
            reachesProduction: declaredBrowser.data.reaches_production,
        }),
        requestPreapproval: declaredBrowser.request_preapproval,
        headed: declaredBrowser.headed,
        artifacts: Object.freeze({ ...declaredBrowser.artifacts }),
    })
}

function projectTestingConfig(declaredTesting: NonNullable<CockpitConfig['testing']>) {
    return Object.freeze({
        declarations: Object.freeze({
            stages: Object.freeze(declaredTesting.stages.map((stage) => Object.freeze({
                id: stage.id,
                command: Object.freeze([...stage.command]) as readonly [string, ...string[]],
                requiresStack: stage.requires_stack,
                timeoutSeconds: stage.timeout_seconds,
            }))),
            gates: Object.freeze(declaredTesting.gates.map((gate) => Object.freeze({
                id: gate.id,
                tier: gate.tier,
                stages: Object.freeze([...gate.stages]),
                changes: gate.changes,
            }))),
        }),
        nativeHookInstall: declaredTesting.native_hooks.install,
        ...(declaredTesting.native_hook_policy === undefined ? {} : {
            nativeHookPolicy: Object.freeze({ ...declaredTesting.native_hook_policy }),
        }),
    })
}

export function projectWorkEnvironmentConfig(
    configuration: LoadedConfigProjection,
): WorkEnvironmentConfigProjection | undefined {
    const loaded = configuration && typeof configuration === 'object' ? issuedConfigProjections.get(configuration) : undefined
    if (!loaded) return undefined
    const policy = validateWorkOrderPolicy({
        cockpitCap: loaded.config.workorders.wip_cap,
        attemptCap: loaded.config.workorders.attempt_cap,
        programmeCap: loaded.config.workorders.programme_wip_cap,
    })
    if (policy.kind !== 'policy') return undefined
    const declaredBrowser = loaded.config.browser
    const browser = declaredBrowser === undefined ? undefined : projectBrowserConfig(declaredBrowser)
    if (browser && (new Set(Object.values(browser.artifacts)).size !== loaded.config.environment.generated_host_paths.length
        || loaded.config.environment.generated_host_paths.some((path) => !Object.values(browser.artifacts).includes(path)))) return undefined
    const testing = loaded.config.testing === undefined ? undefined : projectTestingConfig(loaded.config.testing)
    const result = Object.freeze({ kind: 'work-environment-config-projection' as const })
    issuedWorkEnvironmentConfigProjections.set(result, Object.freeze({
        cockpitName: loaded.config.cockpit.name,
        cockpitRoot: dirname(loaded.source.path),
        siblingsRoot: loaded.config.cockpit.siblings_root,
        source: Object.freeze({ ...loaded.source }),
        siblings: Object.freeze(loaded.config.sibling.map(({ slug, dir, environment_files }) => Object.freeze({ slug, dir,
            environmentFiles: Object.freeze((environment_files ?? []).map(row => Object.freeze({ template: row.template, instance: row.instance }))),
        }))),
        workOrderPolicy: policy.policy,
        generatedHostPaths: Object.freeze([...loaded.config.environment.generated_host_paths]),
        ...(browser === undefined ? {} : { browser }),
        ...(testing === undefined ? {} : { testing }),
    }))
    return result
}

export function consumeWorkEnvironmentConfigProjection(
    projection: WorkEnvironmentConfigProjection,
): ConsumedWorkEnvironmentConfig | undefined {
    if (!projection || typeof projection !== 'object') return undefined
    const loaded = issuedWorkEnvironmentConfigProjections.get(projection)
    issuedWorkEnvironmentConfigProjections.delete(projection)
    return loaded
}

export function projectMachineFloorConfig(projection: LoadedConfigProjection): MachineFloorConfigProjection | undefined {
    const loaded = projection && typeof projection === 'object' ? issuedConfigProjections.get(projection) : undefined
    const machine = loaded?.config.environment.machine
    if (!loaded || !machine) return undefined
    const result = Object.freeze({ kind: 'machine-floor-config-projection' as const })
    issuedMachineFloorConfigProjections.set(result, Object.freeze({
        cockpitName: loaded.config.cockpit.name,
        source: Object.freeze({ ...loaded.source }),
        runtimeSha256: loaded.runtimeSha256,
        floor: Object.freeze({
            runtimeMemoryMb: machine.runtime_memory_mb,
            runtimeCpus: machine.runtime_cpus,
            freeDiskMb: machine.free_disk_mb,
        }),
    }))
    return result
}

export function consumeMachineFloorConfigProjection(
    projection: MachineFloorConfigProjection,
): ConsumedMachineFloorConfig | undefined {
    if (!projection || typeof projection !== 'object') return undefined
    const loaded = issuedMachineFloorConfigProjections.get(projection)
    issuedMachineFloorConfigProjections.delete(projection)
    return loaded
}

export function consumeLoadedConfigProjection(projection: LoadedConfigProjection): ConsumedLoadedConfig | undefined {
    try {
        if (projection === null || typeof projection !== 'object') return undefined
        const loaded = issuedConfigProjections.get(projection)
        issuedConfigProjections.delete(projection)
        return loaded
    } catch {
        return undefined
    }
}

type ConfigSourceRead =
    | { kind: 'available'; source: SourceProvenance; bytes: Buffer }
    | { kind: 'unavailable'; source: Extract<ConfigSourceSnapshot, { state: 'unavailable' }>; tooLarge?: boolean }

async function readConfigSource(inputPath: string): Promise<ConfigSourceRead> {
    const requestedPath = resolve(inputPath)
    let path: string
    try {
        path = await realpath(requestedPath)
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return {
            kind: 'unavailable',
            source: {
                state: 'unavailable',
                path: requestedPath,
                code: code === 'ENOENT' ? ENVIRONMENT_CODES.CONFIG_NOT_FOUND : ENVIRONMENT_CODES.CONFIG_UNREADABLE,
            },
        }
    }
    try {
        const read = await readBoundedInput(path)
        if (read.kind === 'too-large') return {
            kind: 'unavailable', tooLarge: true,
            source: { state: 'unavailable', path, code: ENVIRONMENT_CODES.CONFIG_UNREADABLE },
        }
        const bytes = read.bytes
        return {
            kind: 'available',
            bytes,
            source: {
                path,
                byteLength: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            },
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return {
            kind: 'unavailable',
            source: {
                state: 'unavailable',
                path,
                code: code === 'ENOENT' ? ENVIRONMENT_CODES.CONFIG_NOT_FOUND : ENVIRONMENT_CODES.CONFIG_UNREADABLE,
            },
        }
    }
}

export async function observeConfigSource(inputPath: string): Promise<ConfigSourceSnapshot> {
    const observed = await readConfigSource(inputPath)
    return observed.kind === 'available'
        ? { state: 'available', ...observed.source }
        : observed.source
}

// smol-toml's message embeds a source excerpt; keep only the reason and position so file content is not echoed.
function tomlErrorSummary(error: unknown): string {
    if (!(error instanceof Error)) return 'unknown parse failure'
    const reason = error.message.split('\n', 1)[0]!
    const { line, column } = error as Error & { line?: unknown; column?: unknown }
    return typeof line === 'number' && typeof column === 'number' ? `${reason} (line ${line}, column ${column})` : reason
}

const SCHEMA_ISSUES_SHOWN = 3

export function schemaIssueSummary(
    issues: readonly { path: readonly PropertyKey[]; message: string }[],
    limit = SCHEMA_ISSUES_SHOWN,
): string {
    const shown = issues.slice(0, limit)
        .map(issue => `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`)
    const more = issues.length - shown.length
    return `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`
}

// The schema lets a declared provenance omit observed_on only when the configuration file is
// its own source; only the loader knows that file's name, so it closes the rule here.
function undatedForeignProvenance(value: unknown, configName: string, path: readonly string[] = []): string | undefined {
    if (value === null || typeof value !== 'object') return undefined
    for (const [key, item] of Object.entries(value)) {
        const itemPath = [...path, key]
        if (key === 'provenance' && item !== null && typeof item === 'object' && !Array.isArray(item)
            && !Object.hasOwn(item, 'observed_on') && (item as { source?: unknown }).source !== configName) return itemPath.join('.')
        const nested = undatedForeignProvenance(item, configName, itemPath)
        if (nested !== undefined) return nested
    }
    return undefined
}

function refusal(code: RefusalCode, message: string, target: string, fix?: string): EnvironmentCommandOutcome<LoadedCockpitConfig> {
    const diagnostic: EnvironmentDiagnostic = { severity: 'error', code, message, target, ...(fix ? { fix } : {}) }
    return { kind: 'refusal', status: 2, diagnostics: [diagnostic], result: null }
}

// A `.cockpit/` directory beside the missing file means it was deleted from a cockpit checkout
// rather than mistyped, and every cockpit command and guarded agent call is stranded until it
// comes back; the committed copy is the fastest way back.
async function deletedFromCockpit(path: string): Promise<boolean> {
    try { return (await lstat(join(dirname(path), '.cockpit'))).isDirectory() }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

export async function loadCockpitConfig(
    inputPath: string,
): Promise<EnvironmentCommandOutcome<LoadedCockpitConfig>> {
    const observed = await readConfigSource(inputPath)
    if (observed.kind === 'unavailable') {
        if (observed.source.code === ENVIRONMENT_CODES.CONFIG_NOT_FOUND && await deletedFromCockpit(observed.source.path)) {
            return refusal(observed.source.code,
                `${basename(observed.source.path)} is missing from a cockpit checkout (.cockpit/ is present); every cockpit command and guarded agent call reads it`,
                observed.source.path, `${formatShellCommand(['git', '-C', dirname(observed.source.path), 'restore', '--', basename(observed.source.path)])} (it is committed), then retry`)
        }
        return refusal(
            observed.source.code,
            observed.source.code === ENVIRONMENT_CODES.CONFIG_NOT_FOUND
                ? 'cockpit configuration was not found'
                : observed.tooLarge
                    ? `cockpit configuration exceeds the ${STRUCTURED_INPUT_BYTE_LIMIT}-byte input limit`
                    : 'cockpit configuration could not be read',
            observed.source.path,
        )
    }
    const { bytes, source: provenance } = observed
    const { path } = provenance

    let source: string
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return refusal(ENVIRONMENT_CODES.CONFIG_ENCODING_INVALID, 'cockpit configuration is not valid UTF-8', path)
    }

    let parsed: unknown
    try {
        parsed = parse(source)
    } catch (error) {
        return refusal(ENVIRONMENT_CODES.CONFIG_PARSE_INVALID, `cockpit configuration is not valid TOML: ${tomlErrorSummary(error)}`, path)
    }

    const validated = CockpitConfig.safeParse(parsed)
    if (!validated.success) {
        return refusal(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
            `cockpit configuration does not match the schema: ${schemaIssueSummary(validated.error.issues)}`, path)
    }

    const undated = undatedForeignProvenance(validated.data, basename(path))
    if (undated !== undefined) {
        return refusal(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
            `cockpit configuration does not match the schema: ${undated}: provenance without observed_on must name this configuration file (${basename(path)}) as its source; add observed_on for any other source`, path)
    }

    const reconstructed = CockpitConfig.safeParse(snapshotJson(validated.data))
    if (!reconstructed.success) {
        return refusal(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, 'cockpit configuration does not match the schema', path)
    }
    const writtenGuards = (parsed as { guards?: unknown }).guards
    const guardHostsStated = writtenGuards !== null && typeof writtenGuards === 'object'
        && Object.hasOwn(writtenGuards, 'hosted_db_hosts') && Object.hasOwn(writtenGuards, 'vendor_endpoint_hosts')
    const immutableConfig = snapshotJson(reconstructed.data) as unknown as CockpitConfig
    const runtimeSha256 = runtimeDeclarationSha256(immutableConfig)
    const bound = Object.freeze({
        config: immutableConfig,
        source: Object.freeze({ ...provenance }),
        runtimeSha256,
        guardHostsStated,
    })
    const result = { config: validated.data, source: provenance, runtimeSha256, guardHostsStated } as LoadedCockpitConfig
    issuedConfigProjections.set(result, bound)
    return {
        kind: 'complete',
        status: 0,
        diagnostics: [],
        result,
    }
}
