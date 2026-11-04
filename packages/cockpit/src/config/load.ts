import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parse, TomlError } from 'smol-toml'
import {
    RefusalError,
    ENVIRONMENT_CODES,
    type ConfigSourceSnapshot,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type RefusalCode,
    type SourceProvenance,
    snapshotJson,
} from '../environment/contract.js'
import { effectivePolicy, readRecordedPolicy, type EffectivePolicy } from '../autonomy.js'
import { browserPreapprovalRequested, CockpitConfig, EVALUATOR_COMMANDS, runtimeDeclarationSha256, type EvaluatorTool } from '../schema.js'
import { formatShellCommand } from '../fix-catalogue.js'
import { readBoundedFile, type BoundedRead } from '../bounded-read.js'

export const STRUCTURED_INPUT_BYTE_LIMIT = 1_048_576

type BoundedInputRead = BoundedRead

export async function readBoundedInput(path: string): Promise<BoundedInputRead> {
    return readBoundedFile(path, STRUCTURED_INPUT_BYTE_LIMIT)
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
interface ConsumedMachineFloorConfig {
    readonly cockpitName: string
    readonly source: SourceProvenance
    readonly runtimeSha256: string
    readonly floor: Readonly<{ runtimeMemoryMb: number; runtimeCpus: number; freeDiskMb: number }>
}
const issuedMachineFloorConfigProjections = new WeakMap<object, ConsumedMachineFloorConfig>()

interface WorkEnvironmentConfigProjection { readonly kind: 'work-environment-config-projection' }
export interface ConsumedWorkEnvironmentConfig {
    readonly cockpitName: string
    readonly cockpitRoot: string
    readonly siblingsRoot: string
    readonly source: SourceProvenance
    readonly siblings: readonly Readonly<{ slug: string; dir: string; environmentFiles: readonly Readonly<{ template: string; instance: string }>[] }>[]
    readonly policy: EffectivePolicy
    readonly wipCap: number
    readonly attemptCap: number
    readonly verificationTimeoutSeconds: number
    readonly evaluatorTimeoutSeconds: number
    readonly evaluators: readonly EvaluatorTool[]
    /** False when the order is the surfaces.tools default, which the command may reorder for the tool running it. */
    readonly evaluatorsDeclared: boolean
    readonly generatedHostPaths: readonly string[]
    readonly browser?: ReturnType<typeof projectBrowserConfig>
    readonly testing?: ReturnType<typeof projectTestingConfig>
    readonly docs?: Readonly<{ decisions?: string; decisionsIndex?: string }>
}
const issuedWorkEnvironmentConfigProjections = new WeakMap<object, ConsumedWorkEnvironmentConfig>()

function projectBrowserConfig(declaredBrowser: NonNullable<CockpitConfig['browser']>) {
    return {
        engine: declaredBrowser.engine,
        networkExposure: declaredBrowser.network_exposure,
        ...(declaredBrowser.network_exposure_reason === undefined ? {} : { networkExposureReason: declaredBrowser.network_exposure_reason }),
        harnesses: declaredBrowser.harnesses.map((row) => ({ ...row })),
        images: { mcp: { reference: declaredBrowser.images.mcp.reference, driverVersion: declaredBrowser.images.mcp.driver_version } },
        project: { lockfile: declaredBrowser.project.lockfile, sha256: declaredBrowser.project.sha256, driverVersion: declaredBrowser.project.driver_version,
            ...(declaredBrowser.project.manifest === undefined ? {} : { manifest: declaredBrowser.project.manifest, manifestSha256: declaredBrowser.project.manifest_sha256! }) },
        ...(declaredBrowser.endpoint === undefined ? {} : { endpoint: declaredBrowser.endpoint }),
        maxClients: declaredBrowser.max_clients,
        proxy: {
            ...(declaredBrowser.proxy.host_variable === undefined ? {} : { hostVariable: declaredBrowser.proxy.host_variable }),
            serverPort: declaredBrowser.proxy.server_port,
            proxyPort: declaredBrowser.proxy.proxy_port,
            allowedHosts: [...declaredBrowser.proxy.allowed_hosts],
            bind: declaredBrowser.proxy.bind,
        },
        resolver: declaredBrowser.resolver.map((row) => ({ ...row })),
        authentication: {
            policy: declaredBrowser.authentication.policy,
            states: declaredBrowser.authentication.states.map((row) => ({ ...row })),
        },
        data: {
            mode: declaredBrowser.data.mode,
            isolated: declaredBrowser.data.isolated,
            reachesProduction: declaredBrowser.data.reaches_production,
        },
        requestPreapproval: browserPreapprovalRequested(declaredBrowser),
        artifacts: { ...declaredBrowser.artifacts },
    }
}

function projectTestingConfig(declaredTesting: NonNullable<CockpitConfig['testing']>) {
    return {
        declarations: {
            stages: declaredTesting.stages.map((stage) => ({
                id: stage.id,
                command: [...stage.command] as [string, ...string[]],
                requiresStack: stage.requires_stack,
                timeoutSeconds: stage.timeout_seconds,
                ...(stage.select === undefined ? {} : { select: Object.fromEntries(Object.entries(stage.select)
                    .map(([kind, argv]) => [kind, [...argv]])) }),
            })),
            gates: declaredTesting.gates.map((gate) => ({
                id: gate.id,
                tier: gate.tier,
                stages: [...gate.stages],
                changes: gate.changes,
            })),
        },
        nativeHookInstall: declaredTesting.native_hooks.install,
        ...(declaredTesting.test_files === undefined ? {} : { testFiles: [...declaredTesting.test_files] }),
        ...(declaredTesting.native_hook_policy === undefined ? {} : {
            nativeHookPolicy: { ...declaredTesting.native_hook_policy },
        }),
    }
}

export function projectWorkEnvironmentConfig(
    configuration: LoadedConfigProjection,
): WorkEnvironmentConfigProjection | undefined {
    const loaded = configuration && typeof configuration === 'object' ? issuedConfigProjections.get(configuration) : undefined
    if (!loaded) return undefined
    const declaredBrowser = loaded.config.browser
    const browser = declaredBrowser === undefined ? undefined : projectBrowserConfig(declaredBrowser)
    if (browser && (new Set(Object.values(browser.artifacts)).size !== loaded.config.environment.generated_host_paths.length
        || loaded.config.environment.generated_host_paths.some((path) => !Object.values(browser.artifacts).includes(path)))) return undefined
    const testing = loaded.config.testing === undefined ? undefined : projectTestingConfig(loaded.config.testing)
    const result = { kind: 'work-environment-config-projection' as const }
    issuedWorkEnvironmentConfigProjections.set(result, Object.freeze({
        cockpitName: loaded.config.cockpit.name,
        cockpitRoot: dirname(loaded.source.path),
        siblingsRoot: loaded.config.cockpit.siblings_root,
        source: Object.freeze({ ...loaded.source }),
        siblings: Object.freeze(loaded.config.sibling.map(({ slug, dir, environment_files }) => ({ slug, dir,
            environmentFiles: (environment_files ?? []).map(row => ({ template: row.template, instance: row.instance })),
        }))),
        policy: effectivePolicy(loaded.config),
        wipCap: loaded.config.work.wip_cap,
        attemptCap: loaded.config.work.attempt_cap,
        verificationTimeoutSeconds: loaded.config.work.verification_timeout_seconds,
        evaluatorTimeoutSeconds: loaded.config.work.evaluator_timeout_seconds,
        evaluators: Object.freeze([...evaluatorTools(loaded.config)]),
        evaluatorsDeclared: loaded.config.work.evaluators !== undefined,
        generatedHostPaths: Object.freeze([...loaded.config.environment.generated_host_paths]),
        ...(browser === undefined ? {} : { browser }),
        ...(testing === undefined ? {} : { testing }),
        ...(loaded.config.docs === undefined ? {} : { docs: Object.freeze({
            ...(loaded.config.docs.decisions === undefined ? {} : { decisions: loaded.config.docs.decisions }),
            ...(loaded.config.docs.decisions_index === undefined ? {} : { decisionsIndex: loaded.config.docs.decisions_index }) }) }),
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
    const result = { kind: 'machine-floor-config-projection' as const }
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
    } catch { // A throwing accessor or proxy trap makes the projection malformed; the caller refuses it.
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
// sync records the configuration it read in the ownership manifest, and only that file is known to
// be committed. A mistyped --config beside it was never tracked, so restoring it from git fails.
// The manifest only chooses which remedy to print: one that cannot be read gives the plain refusal,
// and sync and check report the manifest itself.
async function syncedConfigName(directory: string): Promise<string | undefined> {
    let manifest: unknown
    try {
        const read = await readBoundedInput(join(directory, '.cockpit', 'generated-environment-ownership.json'))
        if (read.kind !== 'complete') return undefined
        manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))
    } catch (error) {
        // Absent, unreadable, changing under a concurrent sync, or not JSON: no remedy can be chosen.
        if (error instanceof Error) return undefined
        throw error
    }
    const record = manifest as { format?: unknown; source?: { path?: unknown } } | null
    const name = record?.format === 'cockpit-generated-ownership/v3' ? record.source?.path : undefined
    return typeof name === 'string' && name !== '' && basename(name) === name ? name : undefined
}

/** The policy cockpit.toml declares now and the one the last sync recorded, for a command that gates a decision. */
export async function loadAutonomyPolicy(configPath: string): Promise<Readonly<{ root: string; current: EffectivePolicy; recorded?: EffectivePolicy }>
    | Readonly<{ refusal: EnvironmentDiagnostic }>> {
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete') return { refusal: loaded.diagnostics[0]! }
    const root = dirname(loaded.result.source.path)
    const recorded = await readRecordedPolicy(root)
    return { root, current: effectivePolicy(loaded.result.config), ...recorded ? { recorded } : {} }
}

/** The configuration `bytes` declare, or undefined when they are not UTF-8 TOML the schema accepts. */
export function parseCockpitConfigBytes(bytes: Uint8Array): CockpitConfig | undefined {
    let parsed: unknown
    try { parsed = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch (error) {
        // Invalid UTF-8 or TOML is the answer; anything else is a fault to surface.
        if (error instanceof TypeError || error instanceof TomlError) return undefined
        throw error
    }
    const validated = CockpitConfig.safeParse(parsed)
    return validated.success ? validated.data : undefined
}

export async function loadCockpitConfig(
    inputPath: string,
): Promise<EnvironmentCommandOutcome<LoadedCockpitConfig>> {
    const observed = await readConfigSource(inputPath)
    if (observed.kind === 'unavailable') {
        // Each branch names its code literally so the diagnostic index reads the fix beside it.
        const synced = observed.source.code === ENVIRONMENT_CODES.CONFIG_NOT_FOUND
            ? await syncedConfigName(dirname(observed.source.path)) : undefined
        if (synced === basename(observed.source.path)) {
            return refusal(ENVIRONMENT_CODES.CONFIG_NOT_FOUND,
                `${basename(observed.source.path)} is missing from a cockpit checkout (.cockpit/ is present); every cockpit command and guarded agent call reads it`,
                observed.source.path, `${formatShellCommand(['git', '-C', dirname(observed.source.path), 'restore', '--', basename(observed.source.path)])} (it is committed), then retry`)
        }
        if (synced !== undefined) {
            return refusal(ENVIRONMENT_CODES.CONFIG_NOT_FOUND,
                `${basename(observed.source.path)} does not exist; this cockpit checkout was synced from ${join(dirname(observed.source.path), synced)}`,
                observed.source.path, 'check the --config path, then retry')
        }
        if (observed.source.code === ENVIRONMENT_CODES.CONFIG_NOT_FOUND) {
            return refusal(ENVIRONMENT_CODES.CONFIG_NOT_FOUND, 'cockpit configuration was not found', observed.source.path,
                'pass --config the path of an existing cockpit.toml, or create one with npx --no cockpit init <cockpit root> --target <target>')
        }
        if (observed.tooLarge) {
            return refusal(ENVIRONMENT_CODES.CONFIG_UNREADABLE, `cockpit configuration exceeds the ${STRUCTURED_INPUT_BYTE_LIMIT}-byte input limit`, observed.source.path,
                'cut the configuration below the input limit; it holds declarations, so move any embedded data into the files it names, then retry')
        }
        return refusal(ENVIRONMENT_CODES.CONFIG_UNREADABLE, 'cockpit configuration could not be read', observed.source.path,
            'make --config name a regular file the user running cockpit can read, then retry')
    }
    const { bytes, source: provenance } = observed
    const { path } = provenance

    let source: string
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch { // Fatal decoding throws only for invalid UTF-8, which the refusal names.
        return refusal(ENVIRONMENT_CODES.CONFIG_ENCODING_INVALID, 'cockpit configuration is not valid UTF-8', path,
            'save the configuration as UTF-8, then retry')
    }

    let parsed: unknown
    try {
        parsed = parse(source)
    } catch (error) {
        return refusal(ENVIRONMENT_CODES.CONFIG_PARSE_INVALID, `cockpit configuration is not valid TOML: ${tomlErrorSummary(error)}`, path,
            'correct the TOML at the line and column named, then retry')
    }

    const validated = CockpitConfig.safeParse(parsed)
    if (!validated.success) {
        return refusal(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
            `cockpit configuration does not match the schema: ${schemaIssueSummary(validated.error.issues)}`, path,
            'correct each named key to the shape and values ./node_modules/@b00dea/cockpit/docs/configuration-reference.md gives for it, then retry')
    }

    const undated = undatedForeignProvenance(validated.data, basename(path))
    if (undated !== undefined) {
        return refusal(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
            `cockpit configuration does not match the schema: ${undated}: provenance without observed_on must name this configuration file (${basename(path)}) as its source`, path,
            'add observed_on with the date the source was read, or name this configuration file as the source, then retry')
    }

    const reconstructed = CockpitConfig.safeParse(snapshotJson(validated.data))
    if (!reconstructed.success) {
        return refusal(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, 'cockpit configuration does not match the schema', path,
            'correct each named key to the shape and values ./node_modules/@b00dea/cockpit/docs/configuration-reference.md gives for it, then retry')
    }
    const writtenGuards = (parsed as { guards?: unknown }).guards
    const guardHostsStated = writtenGuards !== null && typeof writtenGuards === 'object'
        && Object.hasOwn(writtenGuards, 'hosted_db_hosts') && Object.hasOwn(writtenGuards, 'vendor_endpoint_hosts')
    const immutableConfig = snapshotJson(reconstructed.data) as unknown as CockpitConfig
    const runtimeSha256 = runtimeDeclarationSha256(immutableConfig)
    const bound = {
        config: immutableConfig,
        source: { ...provenance },
        runtimeSha256,
        guardHostsStated,
    }
    const result = { config: validated.data, source: provenance, runtimeSha256, guardHostsStated } as LoadedCockpitConfig
    issuedConfigProjections.set(result, bound)
    return {
        kind: 'complete',
        status: 0,
        diagnostics: [],
        result,
    }
}

/**
 * The evaluators work grade and cockpit grade try, in order. Left unset, they are the listed agent
 * tools that can evaluate, so a team on one tool is never told to install another to grade.
 */
export function evaluatorTools(config: Pick<CockpitConfig, 'work' | 'surfaces'>): readonly EvaluatorTool[] {
    return config.work.evaluators ?? config.surfaces.tools.filter((tool): tool is EvaluatorTool => Object.hasOwn(EVALUATOR_COMMANDS, tool))
}
