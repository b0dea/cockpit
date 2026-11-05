import { lstat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import { parseDocument } from 'yaml'
import { consumeWorkEnvironmentConfigProjection, loadCockpitConfig, projectWorkEnvironmentConfig } from '../../config/load.js'
import { deriveRegistry } from '../../registry-derivation.js'
import { SURFACE_TARGETS } from '../../surfaces/contract.js'
import { parseOwnershipManifest, type OwnershipManifest } from '../../surfaces/ownership.js'
import { nodeAuthority, readAnchoredFile, readAnchoredConfigSource, type FileIdentity } from '../../generated-environment/transaction.js'
import { ENVIRONMENT_CODES, hasErrorCode } from '../contract.js'
import { publicationCockpitId, stackId } from '../identity.js'
import { composePublishedPorts, variableName } from '../compose-topology.js'
import { COMPOSE_OWNERSHIP_FILE, renderComposeOwnership } from '../compose-ownership.js'
import { earlierNameRefusalMessage, findStackUnderEarlierName } from '../lifecycle-stage.js'
import { selectStateRoot } from '../state.js'
import { observeGeneratedCheckoutIdentity } from '../setup-observation.js'
import { exactKeys } from '../../exact-keys.js'
import { refusalOutcome as refuse } from '../../refusal.js'
import {
    COMPOSE_SOURCE_BYTES,
    type GeneratedEnvironmentCommandAdapters,
    type GeneratedEnvironmentCommandInput,
    type GeneratedEnvironmentSyncInput,
    MAX_OWNERSHIP_BYTES,
    OWNERSHIP_PATH,
    type OwnedBytes,
    type PreparedEnvironment,
    type RefusalOutcome,
    authenticateSiblingRoots,
    compareCodeUnits,
    confined,
    ownRecord,
    sha256,
} from './shared.js'

export function commandInput(input: unknown): GeneratedEnvironmentCommandInput | undefined {
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.some((key) => typeof key !== 'string' || key !== 'configPath')
            || !Object.hasOwn(descriptors, 'configPath') || !('value' in descriptors.configPath!)) return undefined
        const configPath = descriptors.configPath.value
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')) return undefined
        return { configPath }
    } catch {
        // a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses.
        return undefined
    }
}

export function syncCommandInput(input: unknown): GeneratedEnvironmentSyncInput | undefined {
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.some((key) => typeof key !== 'string' || key !== 'configPath' && key !== 'dryRun' && key !== 'bootstrapState')
            || !Object.hasOwn(descriptors, 'configPath') || !('value' in descriptors.configPath!)) return undefined
        const configPath = descriptors.configPath.value
        const dryRun = Object.hasOwn(descriptors, 'dryRun') && 'value' in descriptors.dryRun! ? descriptors.dryRun.value : false
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0') || typeof dryRun !== 'boolean') return undefined
        const bootstrapState = Object.hasOwn(descriptors, 'bootstrapState') && 'value' in descriptors.bootstrapState!
            ? descriptors.bootstrapState.value : undefined
        if (bootstrapState !== undefined) {
            const state = ownRecord(bootstrapState)
            if (!state || !exactKeys(state, ['publication', 'address'])) return undefined
        }
        return { configPath, dryRun, ...(bootstrapState === undefined ? {} : { bootstrapState }) }
    } catch {
        // a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses.
        return undefined
    }
}

export async function safePath(root: string, path: string, allowMissing: boolean): Promise<string | undefined> {
    const target = confined(root, path)
    if (!target) return undefined
    const parts = relative(root, target).split(sep)
    let current = root
    for (const [index, part] of parts.entries()) {
        current = resolve(current, part)
        try {
            const entry = await lstat(current)
            if (entry.isSymbolicLink() || index < parts.length - 1 && !entry.isDirectory()
                || index === parts.length - 1 && !entry.isFile()) return undefined
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) return undefined
            if (!allowMissing && index === parts.length - 1) return undefined
        }
    }
    return target
}

export type OwnershipState = { readonly kind: 'missing' }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'unsupported'; readonly format: string }
    | { readonly kind: 'complete'; readonly manifest: OwnershipManifest; readonly bytes: string; readonly sha256: string; readonly identity: FileIdentity }

export async function readOwnership(
    prepared: PreparedEnvironment,
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<OwnershipState> {
    const read = await readAnchoredFile(prepared.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, prepared.node, adapters)
    if (read.kind === 'missing') return { kind: 'missing' }
    if (read.kind !== 'complete') return { kind: 'invalid' }
    try {
        const bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
        const parsed = parseOwnershipManifest(bytes, { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath })
        return parsed.kind === 'complete' ? { kind: 'complete', manifest: parsed.manifest, bytes, sha256: read.sha256, identity: read.identity } : parsed
    } catch {
        // invalid ownership bytes are reported as invalid.
        return { kind: 'invalid' }
    }
}

export async function expectedOutputExists(prepared: PreparedEnvironment): Promise<boolean> {
    for (const file of prepared.owned) {
        if (await safePath(prepared.root, file.path, false)) return true
    }
    return false
}

// A ledger recorded under another name means `cockpit.name` was renamed. Publishing under the new
// name is safe for the files, but a stack still recorded under the old one would be left where
// down cannot reach it, so the rename waits until that stack is down.
export async function renamedStackRefusal(prepared: PreparedEnvironment): Promise<RefusalOutcome | undefined> {
    const checkout = prepared.checkoutIdentity
    if (prepared.composeSources.length === 0 && !prepared.workEnvironment.browser
        || process.platform !== 'darwin' && process.platform !== 'linux') return undefined
    const namespace = await selectStateRoot({ platform: process.platform, home: process.env.HOME,
        xdgStateHome: process.env.XDG_STATE_HOME,
        checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath], cockpitId: checkout.cockpitId })
    if (namespace.kind !== 'complete') return refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
        `cannot tell whether a stack started before cockpit.name was renamed is still recorded: ${'message' in namespace ? namespace.message : 'the state root is missing'}; nothing was written`, prepared.configPath)
    const earlier = await findStackUnderEarlierName({ namespace: namespace.value, cockpitId: checkout.cockpitId, checkoutId: checkout.checkoutId })
    if (earlier.kind === 'refusal') return refuse(earlier.code, `${earlier.message}; nothing was written`, earlier.target)
    return earlier.name === undefined ? undefined
        : refuse(ENVIRONMENT_CODES.STACK_RECORDED_UNDER_EARLIER_NAME, earlierNameRefusalMessage(prepared.configPath, earlier.name), prepared.configPath)
}

const LOOPBACK_HOST_IPS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Why no single Compose service publishes the endpoint's port on loopback, or undefined when exactly one does. */
export function browserEndpointUnpublished(
    endpoint: string,
    sources: readonly Readonly<{ reference: string; source: string }>[],
    bases: Readonly<Record<string, number>>,
): string | undefined {
    const port = Number(new URL(endpoint).port || 80)
    const publishers: string[] = []
    for (const { reference, source } of sources) {
        const document = parseDocument(source)
        const services = document.errors.length === 0 ? (document.toJS() as { services?: Record<string, { ports?: unknown }> } | null)?.services : undefined
        for (const [id, service] of Object.entries(services ?? {})) {
            const ports = composePublishedPorts(service?.ports)
            if (!ports) return `${reference} service ${id} has a ports entry cockpit cannot read, so it cannot tell whether it publishes browser.endpoint`
            if (ports.some(published => {
                if (published.hostIp === null || !LOOPBACK_HOST_IPS.has(published.hostIp) || published.published === null) return false
                const name = variableName(published.published)
                return (name === undefined ? Number(published.published) : bases[name]) === port
            })) publishers.push(`${reference}:${id}`)
        }
    }
    return publishers.length === 1 ? undefined
        : publishers.length === 0 ? `browser.endpoint port ${port} is not published on loopback by any service in environment.compose_files`
            : `browser.endpoint port ${port} is published on loopback by more than one service (${publishers.join(', ')})`
}

export async function prepare(input: unknown, adapters: GeneratedEnvironmentCommandAdapters): Promise<PreparedEnvironment | RefusalOutcome> {
    const request = commandInput(input)
    if (!request) return refuse('GENERATED_INPUT_INVALID', 'generated environment command input is invalid', 'generated-environment')
    const loaded = await loadCockpitConfig(request.configPath)
    if (loaded.kind !== 'complete') return {
        kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: [...loaded.diagnostics],
    }
    const workProjection = projectWorkEnvironmentConfig(loaded.result)
    const workEnvironment = workProjection && consumeWorkEnvironmentConfigProjection(workProjection)
    if (!workEnvironment || workEnvironment.source.path !== loaded.result.source.path
        || workEnvironment.source.sha256 !== loaded.result.source.sha256) {
        return refuse('GENERATED_RENDER_UNAUTHENTICATED', 'the work environment configuration could not be consumed', loaded.result.source.path)
    }
    const derived = deriveRegistry(loaded.result.config)
    if (derived.kind !== 'complete') return refuse(derived.code, derived.message, loaded.result.source.path)
    const config = derived.result.config
    const root = dirname(loaded.result.source.path)
    const authenticatedSiblings = await authenticateSiblingRoots(root, derived.result.config, loaded.result.source.path)
    if (authenticatedSiblings.kind === 'refusal') return refuse(
        authenticatedSiblings.code ?? 'GENERATED_SIBLING_ROOT_INVALID',
        authenticatedSiblings.reason,
        authenticatedSiblings.target ?? 'sibling',
        authenticatedSiblings.fix,
    )
    const siblingRoots = authenticatedSiblings.roots
    // Surface observations and health must name the same checkout, including a linked worktree
    // or a configuration below its root. The observer also authenticates standalone directories.
    const checkoutIdentity = await observeGeneratedCheckoutIdentity({ source: loaded.result.source, cockpitName: config.cockpit.name,
        env: process.env })
    if (checkoutIdentity.state === 'failed') return refuse('GENERATED_INPUT_INVALID',
        `generated checkout identity is unavailable: ${checkoutIdentity.reason}`, loaded.result.source.path,
        'restore the configuration checkout and Git installation, then run npx --no cockpit sync --config <your cockpit.toml>')
    const currentCockpit = checkoutIdentity.cockpitId
    const publishedCockpit = publicationCockpitId({ name: config.cockpit.name })
    const currentCheckout = checkoutIdentity.checkoutId
    const currentStack = stackId({ cockpitId: currentCockpit, checkoutId: currentCheckout, variant: { kind: 'shared' } })
    // Derived from the runtime declarations, not the file bytes, so rewording a purpose or a guard
    // keeps the running stack's identity.
    const generation = sha256(`generated-environment\0${loaded.result.runtimeSha256}`)
    const node = await nodeAuthority()
    if (!node) return refuse(
        'GENERATED_EXECUTABLE_UNAVAILABLE',
        'the current Node executable could not be authenticated',
        process.execPath,
    )
    let composeOwnership: OwnedBytes | undefined
    const composeSources: PreparedEnvironment['composeSources'][number][] = []
    const sources: { reference: string; source: string }[] = []
    if (config.environment.compose_files.length > 0) {
        for (const reference of config.environment.compose_files) {
            const read = await readAnchoredFile(root, reference, COMPOSE_SOURCE_BYTES, node, adapters)
            if (read.kind !== 'complete') return refuse('GENERATED_PATH_UNSAFE',
                'a declared Compose file is missing, unreadable, or crosses a symbolic-link boundary', reference)
            sources.push({ reference, source: read.bytes.toString('utf8') })
            composeSources.push({ path: reference, sha256: read.sha256, identity: read.identity })
        }
        const ownership = renderComposeOwnership({ sources, stackId: currentStack, cockpitId: currentCockpit,
            configSha256: loaded.result.runtimeSha256, resettableVolumes: config.environment.resettable_volumes })
        if (ownership.kind !== 'complete') return refuse('GENERATED_DECLARATION_INVALID',
            `the ownership override cannot be rendered from environment.compose_files: ${ownership.reason}`, ownership.target)
        composeOwnership = { path: COMPOSE_OWNERSHIP_FILE, bytes: ownership.bytes, sha256: sha256(ownership.bytes) }
    }
    // A browser endpoint is a server the project's own Compose files run, so it must be reachable
    // only from this machine, by exactly the service that publishes its port.
    const endpoint = workEnvironment.browser?.endpoint
    const unpublished = endpoint === undefined ? undefined : browserEndpointUnpublished(endpoint, sources, config.ports.bases)
    if (unpublished) return refuse('GENERATED_BROWSER_ENDPOINT_UNPUBLISHED', unpublished, 'browser',
        'publish the endpoint port from exactly one service in environment.compose_files as "127.0.0.1:${VAR}:<container port>" with VAR under [ports.bases] set to the endpoint port, or remove browser.endpoint to drive a local browser, then run npx --no cockpit sync --config <your cockpit.toml>')
    const generated = composeOwnership ? [composeOwnership] : []
    // The anchored read of the configuration file pins the publication root's identity for the whole sync.
    const sourcePath = relative(root, loaded.result.source.path)
    const sourceTarget = await safePath(root, sourcePath, false)
    if (!sourceTarget) return refuse(
        'GENERATED_CONFIG_SOURCE_UNAVAILABLE',
        'the cockpit configuration file is missing or crosses a symbolic-link boundary',
        sourcePath,
    )
    const source = await readAnchoredConfigSource(root, sourcePath, node, adapters)
    if (!source) {
        return refuse('GENERATED_CONFIG_SOURCE_UNAVAILABLE', 'the cockpit configuration file is unreadable', sourcePath)
    }
    const owned = [...generated].sort((left, right) => compareCodeUnits(left.path, right.path))
    if (new Set(owned.map(({ path }) => path)).size !== owned.length
        || owned.some(({ path }) => path === OWNERSHIP_PATH)
        || owned.some(({ path }) => [loaded.result.source.path, sourceTarget].includes(resolve(root, path)))) {
        return refuse('GENERATED_PATH_DUPLICATE', 'generated ownership contains a duplicate or input path', 'generated-environment')
    }
    for (const file of owned) {
        if (!await safePath(root, file.path, true)) {
            return refuse('GENERATED_PATH_UNSAFE', 'generated destination crosses an existing symbolic-link or non-directory boundary', file.path)
        }
    }
    const producedAt = (adapters.now ?? (() => new Date().toISOString()))()
    const now = producedAt.slice(0, 10)
    return {
        root,
        cockpitId: publishedCockpit,
        stackId: currentStack,
        checkoutIdentity,
        configPath: loaded.result.source.path,
        sourceSha256: loaded.result.source.sha256,
        runtimeSha256: loaded.result.runtimeSha256,
        configSource: { path: sourcePath, sha256: source.sha256 },
        configSourceIdentity: source.identity,
        generation,
        generated,
        owned,
        surfaces: [],
        compactSurfacePaths: new Set<string>(),
        configuredHarnesses: [...SURFACE_TARGETS],
        activeSurfaceOverrides: [],
        changedOverrideOriginals: [],
        composeSources,
        guideSources: { requests: [], observations: [], missing: [] },
        openCodeGrantRoots: [],
        sourceEvidence: [],
        sourceRoots: [],
        customSources: [],
        adoptedSources: [],
        surfaceAssets: [],
        warnings: [],
        unapprovedMcpServers: [],
        mcpTransportGaps: [],
        mcpServers: [],
        registry: derived.result,
        siblingRoots,
        workEnvironment,
        node,
        now,
        producedAt,
    }
}
