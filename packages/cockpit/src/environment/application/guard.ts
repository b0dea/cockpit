import { createHash } from 'node:crypto'
import { lstatIfPresentSync } from '../presence.js'
import { accessSync, constants, lstatSync, realpathSync, statSync, type Stats } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { executeProbe, type ExecuteProbeOutcome } from '../../environment-exec/execute.js'
import {
    hasErrorCode,
    RefusalError,
    ENVIRONMENT_CODES,
    errorCause,
    type EnvironmentCommandOutcome,
    type ExecutionStep,
    snapshotJson,
    tryParseJson,
} from '../contract.js'
import { GUARD_EXECUTABLE_SEARCH_PATH, type ExecutableResolution, type ResolvedExecutable } from '../executable.js'
import { CockpitConfig } from '../../schema.js'
import { correctsHeldConfiguration, pinnedPolicyDenial, restoresRecordedConfiguration } from '../../guards/policy-pin.js'
import { GUARD_RESTORE_LIMIT, guardConfigChange, guardConfigHeldReason } from '../../guards/policy-change.js'
import {
    evaluateGuard,
    approvedReadOnlyInvocation,
    cockpitShaped,
    gitInvocation,
    GUARD_BRANCH_VERBS,
    gitTreeTargets,
    foldGuardSpelling,
    GUARD_LOCATION_LIMITS,
    GUARD_ROOT_PROTECTIONS,
    guardIdentity,
    type GuardDecision,
    type GuardEvaluationPolicy,
    type GuardProtectedIdentity,
    type GuardInvocationProfile,
    type GuardProjectCommand,
} from '../../guards/evaluator.js'
import { commandSpelling, ordinarySessionCommand, resolveOrdinaryInvocation, type OrdinaryGrant } from '../../command-table.js'
import { effectivePolicy, trustInForce } from '../../autonomy.js'
import { GUARD_INPUT_LIMITS, parseGuardInput } from '../../guards/invocation-parser.js'
import { readAnchoredFile, readAnchoredBatches, nodeAuthority } from '../../generated-environment/transaction.js'
import { parseOwnershipManifest } from '../../surfaces/ownership.js'
import { installedPackageMetadata } from '../../package-metadata.js'
import { ANSWER_CONFIRMATION_PATH } from '../../guards/answer-confirmation.js'
import { GUARD_LOCAL_PATHS, parseGuardLocalIdentity, type GuardHandlerIdentity } from '../../guards/local-identity.js'
import {
    guardInstalledDirectories,
    guardLauncherEvidence,
    guardSearchDirectories,
    guardSearchPathRelativeEntry,
    guardSecretFiles,
    guardSensitivePathsBelow,
    guardBranchFacts,
    guardPackageManifest,
    guardPatchTargets,
    guardRemoteCredentials,
    guardWorktreeChanges,
    guardTrackedSensitivePaths,
    guardUnignoredSensitivePaths,
} from '../../guards/protected-locations.js'
import { classifyReadOnlyInvocation, cockpitLauncherPrefix } from '../../guards/read-only.js'
import { fileFingerprint, recordVerifiedDigest } from '../../environment-exec/verified-digest.js'
import { GUARD_HELD_CALLS, GUARD_UNHELD_CALLS, isGuardSurfaceTarget, type GuardSurfaceTarget } from '../../surfaces/harness-registry.js'
import { formatShellCommand, type FixContext } from '../../fix-catalogue.js'
import { guardRecovery, installedSyncCommand } from '../../surfaces/guard-recovery.js'
import { redactSensitiveMessage } from '../sensitive.js'
import { observeComposeTopology } from '../compose-topology.js'
import { declaredRuntime } from '../declaration.js'
import { observeInstallPolicyLockfiles, withInstallPolicyProjection } from '../install-policy-observation.js'
import { resolveInstallPolicies, renderGuardProjectCommand } from '../install-policy.js'
import { checkoutId as deriveCheckoutId, publicationCockpitId } from '../identity.js'
import {
    consumeSetupCheckoutProjection,
    observeSetupCheckout,
    withSetupCheckoutProjection,
    type SetupCheckoutObservation,
} from '../setup-observation.js'
import { browserPreapprovalRequested, loadCockpitConfig, consumeLoadedConfigProjection, parseCockpitConfigBytes, STRUCTURED_INPUT_BYTE_LIMIT, withRecordedDeclarations, type LoadedConfigProjection } from '../../config/load.js'
import { deriveRegistry } from '../../registry-derivation.js'
import { confinedPath, lifecycleRefusal, ownDataValues, sameSource } from './shared.js'
import { splitRepositoryPath } from '../../repository-path.js'
import { readSiblingCheckouts, servedSiblings, type ServedSibling, type SiblingCheckoutRecordRead } from '../sibling-checkouts.js'

export interface GuardEvaluationApplicationInput {
    readonly identity: unknown
    /** The checkout the invoked guard script resolved from its own location. */
    readonly guardRoot: string
    readonly payload: unknown
    readonly harness: GuardSurfaceTarget
    readonly cwd: string
    readonly askIsDeny?: boolean
    readonly ripgrepConfigActive?: boolean
    /** The harness's command search path, whose directories inside the allowed roots the guard protects. */
    readonly searchPath?: string
    /** HOME and XDG_CONFIG_HOME of the harness, where Git reads the person's global configuration. */
    readonly home?: string
    readonly xdgConfigHome?: string
}

interface GuardEvaluationApplicationAdapters {
    readonly loadConfig: typeof loadCockpitConfig
    readonly observeCheckout: typeof observeSetupCheckout
    readonly resolveGit: () => Promise<import('../executable.js').ExecutableResolution>
    /** Needed only by a compose-first cockpit, whose service list is read from its Compose files. */
    readonly resolveDocker?: () => Promise<import('../executable.js').ExecutableResolution>
    readonly execute?: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
}

// `npx --no cockpit logs --service <id>` is an ordinary invocation only for a declared service. A
// cockpit's services are whatever its own Compose files resolve to, so they are read from Compose
// rather than guessed, and an unreadable topology refuses.
async function guardServiceIds(
    config: CockpitConfig,
    root: string,
    observe: Readonly<{
        node: ResolvedExecutable
        resolveDocker?: () => Promise<ExecutableResolution>
        execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    }>,
): Promise<readonly string[] | string> {
    const runtime = declaredRuntime(config.environment)
    if (runtime === 'none') return []
    const docker = observe.resolveDocker ? await observe.resolveDocker() : undefined
    if (docker?.state !== 'available') return docker?.reason ?? 'no Docker executable resolver is bound'
    const topology = await observeComposeTopology({ root, references: config.environment.compose_files,
        projectName: config.cockpit.name, docker: docker.value, node: observe.node, env: { PATH: GUARD_EXECUTABLE_SEARCH_PATH } }, observe.execute)
    return topology.kind === 'complete' ? topology.services.map(service => service.id) : topology.reason
}

interface GuardEvaluationApplicationResult {
    readonly decision: GuardDecision
    readonly diagnostics: readonly import('../contract.js').Diagnostic[]
    readonly fixContext?: FixContext
}

// Every refusal below holds all of the agent's guarded calls, `git restore` included, so each says what
// failed, why that blocks everything, and the human action that clears it. Regeneration is a human
// step on purpose: guard policy comes from cockpit.toml, and an agent able to apply its own edit
// could loosen its guard.
function recoveryFile(path: string, mode: number): boolean {
    try {
        if (!statSync(path).isFile()) return false
        accessSync(path, mode)
        return true
    } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].some(code => hasErrorCode(error, code))) return false
        throw error
    }
}

function recoveryState(identity: GuardHandlerIdentity): Readonly<{ config: boolean; package: boolean }> {
    const installed = join(identity.root, 'node_modules/@b00dea/cockpit')
    return {
        config: recoveryFile(identity.configPath, constants.R_OK),
        package: recoveryFile(join(installed, 'bin/cockpit.mjs'), constants.X_OK)
            && recoveryFile(join(installed, 'dist/cli.js'), constants.R_OK),
    }
}

function guardHeld(identity: GuardHandlerIdentity, what: string, why: string, fix = guardRecovery(identity.root, identity.configPath, recoveryState(identity))): string {
    return `${what}; ${why}, so ${GUARD_HELD_CALLS} are held, including a sync run through this agent, while ${GUARD_UNHELD_CALLS} continue. ${fix}`
}

// Which way the installed cockpit moved from the one that generated the guards decides the fix: an
// older one installed, as after switching to a branch whose lockfile pins it, is fixed by installing
// the dependencies again, and sync would only regenerate the guards with the older version.
function versionOrder(left: string, right: string): number | undefined {
    const parts = (version: string) => /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)?.slice(1).map(Number)
    const [a, b] = [parts(left), parts(right)]
    if (!a || !b) return undefined
    for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! - b[index]!
    return undefined
}

const LOCKFILE_INSTALLS: readonly (readonly [string, string])[] = [['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'], ['package-lock.json', 'npm ci'],
    ['yarn.lock', 'yarn install --immutable'], ['bun.lock', 'bun install --frozen-lockfile'], ['bun.lockb', 'bun install --frozen-lockfile']]

/** The hold for guards a different cockpit version generated, naming the direction and the command that fixes it. */
function versionDrift(identity: GuardHandlerIdentity, generated: string | undefined): string {
    const installed = installedPackageMetadata.version
    const order = generated === undefined ? undefined : versionOrder(installed, generated)
    const why = 'the guard trusts only the cockpit, Node and configuration it was generated for'
    if (order === undefined || order > 0) {
        const what = generated === undefined || generated === installed
            ? 'the installed cockpit version changed (its handler bytes differ) since the guards were generated'
            : `the installed cockpit version changed since the guards were generated: ${installedPackageMetadata.name} ${installed} is installed, newer than ${generated}, which generated them`
        return guardHeld(identity, what, why)
    }
    const lockfile = LOCKFILE_INSTALLS.find(([file]) => recoveryFile(join(identity.root, file), constants.R_OK))
    const install = lockfile ? `\`${lockfile[1]}\`` : 'the repository\'s documented dependency install'
    return guardHeld(identity,
        `the installed cockpit is older than the one that generated the guards: ${installedPackageMetadata.name} ${installed} is installed, and ${generated} generated them, as after switching to a branch or checkout whose dependencies were installed earlier`,
        why, `Fix: install the dependencies the lockfile pins, with ${install} in ${formatShellCommand([identity.root])}, outside the agent; sync is not the fix, since it would regenerate the guards with the older version. If the older version is intended, a human runs \`${installedSyncCommand(identity.root, identity.configPath)}\` in a terminal instead.`)
}

// An edit that does not widen what agents may do is judged as written, so a policy it cannot build
// leaves nothing to judge a call by. Sync can refuse such an edit too, so undoing it exactly stays open
// or the agent could never recover.
function unbuildableEdit(identity: GuardHandlerIdentity, detail: string): GuardEvaluationApplicationResult {
    const reason = `${guardHeld(identity, `${identity.configPath} changed since the guards were generated without widening what agents may do, but the guard cannot build its policy from it (${detail})`,
        'calls are judged under the configuration on disk')} If sync refuses the edit, undo it: one edit or write of ${identity.configPath} that leaves it byte-identical to ${GUARD_LOCAL_PATHS.generatedConfig} is admitted; ${GUARD_RESTORE_LIMIT}.`
    return { decision: { decision: 'unavailable', reason }, diagnostics: [{ severity: 'error', target: 'guard', message: reason,
        code: 'GUARD_CONFIG_UNSYNCED' as const satisfies typeof ENVIRONMENT_CODES.GUARD_CONFIG_UNSYNCED,
        fix: `correct ${identity.configPath} and have a person run ${installedSyncCommand(identity.root, identity.configPath)} in a terminal, or undo the edit: the guard admits one edit of ${identity.configPath} that leaves it byte-identical to ${GUARD_LOCAL_PATHS.generatedConfig}; ${GUARD_RESTORE_LIMIT}` }] }
}

// A guard message reaches the agent and the harness's log: text it forwards from a failure stays one
// bounded line with credential-shaped values removed.
function forwardedReason(reason: string): string {
    return redactSensitiveMessage(reason.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/(\w+:\/\/)[^/@\s]+@/g, '$1[redacted]@').slice(0, 512)) ?? 'the reason was withheld because it could not be redacted'
}

const restored: GuardEvaluationApplicationResult = { decision: { decision: 'allow', reason: 'The edit restores the configuration the guards were generated from.' }, diagnostics: [] }
const correcting: GuardDecision = { decision: 'allow', reason: 'The configuration does not load, and this edit of it changes no pinned table; it takes effect only once it loads, and one that widens waits for a person.' }
const reporting: GuardDecision = { decision: 'allow', reason: 'The configuration does not load, and this command only reports on it.' }
// How cockpit's own messages spell the installed launcher from the cockpit root.
const launcherSpelling = './node_modules/@b00dea/cockpit/bin/cockpit.mjs'

/**
 * `check` or `sync --dry-run` of the configuration, alone, from the cockpit root, through a launcher
 * proven to start the installed cockpit: the reports an agent needs to mend a configuration that does
 * not load. Both read and print; neither writes a file the guard relies on.
 */
function heldConfigurationCheck(parsed: Readonly<{ invocations: readonly import('../../guards/invocation-parser.js').ParsedInvocation[] }>, identity: GuardHandlerIdentity, searchPath: string): boolean {
    if (parsed.invocations.length !== 1) return false
    const [invocation] = parsed.invocations as [import('../../guards/invocation-parser.js').ParsedInvocation]
    if (invocation.executable === null || invocation.wrapped || invocation.dynamic || invocation.redirects.length || invocation.cwd !== identity.root
        || invocation.words.some(word => word.role === 'environment-assignment-value')) return false
    const prefix = cockpitLauncherPrefix(invocation.executable, invocation.argv)
    if (prefix === undefined) return false
    const launcher = resolve(dirname(identity.module), '../bin/cockpit.mjs')
    if (guardLauncherEvidence(invocation.executable, invocation.argv.slice(0, prefix), invocation.cwd, identity.root, launcher, searchPath) === undefined) return false
    const args = invocation.argv.slice(prefix)
    const config = (word: string | undefined) => word !== undefined && !word.split('/').includes('..') && resolve(invocation.cwd, word) === identity.configPath
    return args.length === 3 && args[0] === 'check' && args[1] === '--config' && config(args[2])
        || args.length === 4 && args[0] === 'sync' && (args[1] === '--dry-run' && args[2] === '--config' && config(args[3])
            || args[1] === '--config' && config(args[2]) && args[3] === '--dry-run')
}

/** Installed bytes are authority only while their source, roots and publication still match. */
export async function runGuardEvaluationApplication(
    input: GuardEvaluationApplicationInput,
    adapters: GuardEvaluationApplicationAdapters,
): Promise<GuardEvaluationApplicationResult> {
    // Set once the configuration on disk is known to carry a widening edit; every refusal after that ends with it.
    let notice = ''
    const unavailable = (stated: string): GuardEvaluationApplicationResult => {
        const reason = stated + notice
        return { decision: { decision: 'unavailable', reason }, diagnostics: [{ severity: 'error', code: 'GUARD_AUTHORITY_UNAVAILABLE', message: reason, target: 'guard' }] }
    }
    const refused = (decision: GuardDecision): GuardEvaluationApplicationResult => {
        if (decision.decision === 'allow') return { decision, diagnostics: [] }
        const reason = decision.reason + notice
        return { decision: { ...decision, reason }, diagnostics: [{ severity: 'error', code: 'GUARD_REFUSED', message: reason, target: 'guard' }] }
    }
    try {
        const data = ownDataValues(snapshotJson(input), ['cwd', 'guardRoot', 'harness', 'identity', 'payload'], ['askIsDeny', 'ripgrepConfigActive', 'searchPath', 'home', 'xdgConfigHome'])
        const directory = (value: unknown) => value === undefined || typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)
            && Buffer.byteLength(value) <= GUARD_INPUT_LIMITS.pathBytes
        if (!data || !directory(data.home) || !directory(data.xdgConfigHome)
            || data.searchPath !== undefined && (typeof data.searchPath !== 'string' || /[\x00-\x1f\x7f]/.test(data.searchPath) || Buffer.byteLength(data.searchPath) > GUARD_INPUT_LIMITS.inputBytes)
            || data.askIsDeny !== undefined && typeof data.askIsDeny !== 'boolean'
            || data.ripgrepConfigActive !== undefined && typeof data.ripgrepConfigActive !== 'boolean'
            || !isGuardSurfaceTarget(data.harness)) return unavailable('Guard request is malformed.')
        const harness = data.harness
        const captured = ownDataValues(snapshotJson(data.identity), ['root', 'rootInode', 'configPath', 'configSha256', 'configInode', 'node', 'nodeSha256', 'nodeFingerprint', 'module', 'moduleSha256'])
        if (!captured
            || !Object.values(captured).every(value => typeof value === 'string')
            || !['configSha256', 'nodeSha256', 'moduleSha256'].every(key => /^[a-f0-9]{64}$/.test(String(captured[key])))) return unavailable('Installed guard identity is missing or malformed.')
        const identity = captured as unknown as GuardHandlerIdentity
        if ([identity.root, identity.configPath, identity.node, identity.module].some(path => !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f-\x9f]/.test(path))
            || dirname(identity.configPath) !== identity.root || typeof data.cwd !== 'string' || realpathSync(data.cwd) !== data.cwd
            // A local identity copied from another checkout would evaluate this one under that one's policy.
            || data.guardRoot !== identity.root
            ) return unavailable('Installed guard location does not match this application.')
        const changed = (what: string) => unavailable(guardHeld(identity, `${what} since the guards were generated`,
            'the guard trusts only the cockpit, Node and configuration it was generated for'))
        if (realpathSync(fileURLToPath(new URL('../../../dist/cli.js', import.meta.url))) !== identity.module) return changed('a different cockpit installation is running')
        const roots = new Map<string, Stats>()
        for (const [path, directory] of [[identity.root, true], [identity.configPath, false]] as const) {
            let status: Stats
            try { status = lstatSync(path) }
            catch (error) {
                if (hasErrorCode(error, 'ENOENT') && !directory) return unavailable(guardHeld(identity,
                    `${identity.configPath} is missing`, 'guard policy comes from it'))
                throw error
            }
            // The configuration is authenticated by its content digest below. Holding on its inode
            // as well refused the identical bytes that `git restore`, `sed -i` and editors that save
            // by rename leave in a new file, until a human ran sync for no change.
            if (status.isSymbolicLink() || (directory ? !status.isDirectory() : !status.isFile())
                || directory && String(status.ino) !== identity.rootInode
                || realpathSync(path) !== path) {
                return changed(directory ? `the cockpit checkout ${path} was moved or replaced` : `${path} was replaced by a link or a non-file`)
            }
            roots.set(path, status)
        }
        // Re-hashing a 100 MB Node binary in every guard process dominated each call. The local record
        // carries the fingerprint sync hashed; an identical path, inode, size, mode and timestamps
        // stand in for the re-hash, and the local record is checked against this identity below.
        const nodePath = realpathSync(process.execPath)
        if (nodePath === identity.node && fileFingerprint(nodePath, lstatSync(nodePath)) === identity.nodeFingerprint) {
            recordVerifiedDigest(identity.nodeFingerprint, identity.nodeSha256)
        }
        const node = await nodeAuthority()
        if (!node || node.canonicalPath !== identity.node || node.sha256 !== identity.nodeSha256) return changed(`the Node executable changed (now ${node?.canonicalPath ?? 'unreadable'})`)
        const read = async (root: string, path: string, maxBytes: number) => {
            const result = await readAnchoredFile(root, path, maxBytes, node, { execute: adapters.execute ?? executeProbe })
            if (result.kind !== 'complete') throw new RefusalError('Guard authority file is missing, changed, oversized or crosses a symlink boundary.')
            return result
        }
        const manifestPath = '.cockpit/generated-environment-ownership.json'
        const registration = { claudecode: '.claude/settings.json', codexcli: '.codex/hooks.json', opencode: '.opencode/plugin/cockpit-guards.js' }[harness]
        // The configuration rides in the same batch: the policy pin applies an edit to exactly these bytes.
        const configName = basename(identity.configPath)
        const publicationRequests = [manifestPath, '.cockpit/guards/bash-guard.sh', registration, GUARD_LOCAL_PATHS.identity, configName].map(path => ({
            path, action: 'read-file' as const, maxBytes: path === manifestPath || path === configName ? 1_048_576 : 65_536,
        }))
        const readPublication = async (requests = publicationRequests) => {
            const batch = await readAnchoredBatches(identity.root, requests, node, { execute: adapters.execute ?? executeProbe })
            if (batch?.kind !== 'complete' || batch.results.length !== requests.length) throw new RefusalError('Guard publication read could not be authenticated.')
            return new Map(requests.map((request, index) => {
                const result = batch.results[index]
                if (result?.kind === 'missing') throw new GuardFileMissing(request.path)
                if (result?.kind !== 'complete') throw new RefusalError('Guard authority file is missing, changed, oversized or crosses a symlink boundary.')
                return [request.path, result] as const
            }))
        }
        // The module, configuration and publication reads are independent and each costs a child
        // process, so they run together. Results are consumed in the order the checks below need, so
        // the first failing check is the one reported.
        const settle = <T>(work: Promise<T>) => work.then(value => ({ value }), (error: unknown) => ({ error }))
        const unwrap = <T>(settled: { value: T } | { error: unknown }): T => { if ('error' in settled) throw settled.error; return settled.value }
        const modulePending = settle(read(dirname(identity.module), basename(identity.module), 16_777_216))
        const configPending = settle(adapters.loadConfig(identity.configPath))
        const publicationPending = settle(readPublication())
        const checkoutsPending = settle(readSiblingCheckouts(identity.root))
        const module = unwrap(await modulePending)
        if (module.sha256 !== identity.moduleSha256) {
            // The manifest names the version that generated the guards; it is read here only to word the fix.
            const settled = await publicationPending
            const manifest = 'value' in settled ? tryParseJson(settled.value.get(manifestPath)!.bytes.toString('utf8')) : undefined
            const producer = manifest && typeof manifest === 'object' ? (manifest as { producer?: { version?: unknown } }).producer?.version : undefined
            return unavailable(versionDrift(identity, typeof producer === 'string' ? producer : undefined))
        }
        // What an admitted call rests on besides the configuration: the bytes sync published, for this
        // machine and this cockpit.
        const authenticatePublication = async (pending: typeof publicationPending, cockpitName: string) => {
            let publication: Awaited<ReturnType<typeof readPublication>>
            try { publication = unwrap(await pending) }
            catch (error) {
                if (!(error instanceof GuardFileMissing)) throw error
                return { held: unavailable(guardHeld(identity, `${error.path} is missing`, error.path === GUARD_LOCAL_PATHS.identity
                    ? 'it records the Node executable and cockpit handler on this machine, which committed files cannot carry'
                    : 'it authenticates the guard and the hook that launches it')) }
            }
            const local = parseGuardLocalIdentity(publication.get(GUARD_LOCAL_PATHS.identity)!.bytes.toString('utf8'))
            if (!local || !isDeepStrictEqual(local, identity)) return { held: unavailable('Installed guard identity does not match its machine-local record.') }
            const manifestRead = publication.get(manifestPath)!
            const ownership = parseOwnershipManifest(manifestRead.bytes.toString('utf8'), {
                root: identity.root, configPath: identity.configPath,
                cockpitId: publicationCockpitId({ name: cockpitName }),
            })
            if (ownership.kind !== 'complete' || ownership.manifest.source.sha256 !== identity.configSha256) return { held: unavailable('Installed guard publication is stale or unauthenticated.') }
            const producer = ownership.manifest.producer
            if (producer.package !== installedPackageMetadata.name
                || producer.version !== installedPackageMetadata.version
                || producer.sourceRevision !== installedPackageMetadata.cockpitSourceRevision) {
                if (producer.package === installedPackageMetadata.name && producer.version !== installedPackageMetadata.version) return { held: unavailable(versionDrift(identity, producer.version)) }
                return { held: changed(`the installed cockpit version changed (the guards were generated by ${producer.package} ${producer.version}, ${installedPackageMetadata.name} ${installedPackageMetadata.version} is installed)`) }
            }
            const published = new Map<string, string>()
            for (const path of ['.cockpit/guards/bash-guard.sh', registration]) {
                const entry = ownership.manifest.entries.find(entry => entry.path === path)
                const actual = publication.get(path)!
                if (!entry || entry.kind !== 'file' || entry.sha256 !== actual.sha256) return { held: unavailable('Installed guard registration or launcher bytes drifted.') }
                published.set(path, actual.sha256)
            }
            return { publication, manifestRead, published }
        }
        const anchored = (path: string) => readAnchoredFile(identity.root, path, STRUCTURED_INPUT_BYTE_LIMIT, node, { execute: adapters.execute ?? executeProbe })
        const loaded = unwrap(await configPending)
        if (loaded.kind !== 'complete' || loaded.result.source.path !== identity.configPath) {
            const held = guardHeld(identity, `${identity.configPath} changed since the guards were generated and does not load${loaded.kind === 'complete' ? '' : ` (${forwardedReason(loaded.diagnostics[0]?.message ?? 'no reason given')})`}`,
                'guard policy comes from it and an edit takes effect only once a human approves it')
            const hold = unavailable(`${held} Sync refuses a file that does not load, so correct it first: an edit, write or patch of ${identity.configPath} alone that leaves [work], [autonomy] and MCP restrictions as they are is admitted, and so are \`${formatShellCommand([launcherSpelling, 'check', '--config', configName])}\` and \`${formatShellCommand([launcherSpelling, 'sync', '--dry-run', '--config', configName])}\` run alone from the cockpit root, to see what is wrong. Or undo it: one edit or write that leaves it byte-identical to ${GUARD_LOCAL_PATHS.generatedConfig}; ${GUARD_RESTORE_LIMIT}.`)
            // Restoring the recorded bytes needs no policy, so a file with none to offer is no reason to
            // refuse it; without this an agent's valid-TOML edit the schema rejects stranded it.
            const parsed = parseGuardInput(data.payload)
            if (parsed.status !== 'parsed' || parsed.cwd !== data.cwd) return hold
            const current = await anchored(configName)
            const recorded = await anchored(GUARD_LOCAL_PATHS.generatedConfig)
            const recordedConfig = recorded.kind === 'complete' && recorded.sha256 === identity.configSha256 ? parseCockpitConfigBytes(recorded.bytes) : undefined
            if (!recordedConfig || recorded.kind !== 'complete') return hold
            // A file too large to read gets the empty text, which an edit cannot match; a write needs none.
            const currentText = current.kind === 'complete' ? current.bytes.toString('utf8') : ''
            // The agent that broke the file can mend it, and read what check reports about it, without a
            // person; everything else waits for a file that loads. Neither grants anything: a correction
            // that widens what agents may do still waits for a person's sync once it loads.
            const correction = restoresRecordedConfiguration(parsed, currentText, identity.configPath, identity.configSha256) ? 'admit'
                : correctsHeldConfiguration(parsed, current.kind === 'complete' ? currentText : undefined, recorded.bytes.toString('utf8'), identity.configPath)
            const admitted = correction === 'admit' ? correcting : correction ?? (heldConfigurationCheck(parsed, identity, data.searchPath ?? '') ? reporting : undefined)
            if (!admitted) return hold
            if (admitted.decision !== 'allow') return refused(admitted)
            const authenticated = await authenticatePublication(settle(readPublication(publicationRequests.filter(request => request.path !== configName))), recordedConfig.cockpit.name)
            return authenticated.held ?? { decision: admitted, diagnostics: [] }
        }
        // Every check below runs against the configuration on disk. An edit since sync that does not
        // widen the one the guards were generated from grants nothing the last sync did not, so calls are
        // judged under it; holding every call but sync until it ran was stricter than a widening edit.
        // One that widens is not applied: calls are judged under the declarations last synced, which the
        // recorded copy holds, and only a person may sync it in. Holding every call instead stopped the
        // agent each time someone added an allow rule, though continuing under the approved policy grants
        // nothing new.
        const configSha256 = loaded.result.source.sha256
        const unsynced = configSha256 !== identity.configSha256
        let declared: LoadedConfigProjection = loaded.result
        if (unsynced) {
            const [recorded, confirmations] = await Promise.all([anchored(GUARD_LOCAL_PATHS.generatedConfig), anchored(ANSWER_CONFIRMATION_PATH)])
            const change = guardConfigChange(identity.configSha256, recorded.kind === 'complete' ? recorded.bytes : undefined,
                { sha256: configSha256, config: loaded.result.config }, confirmations.kind === 'complete' ? confirmations.bytes : undefined)
            const approved = change.kind === 'widening' && recorded.kind === 'complete' ? withRecordedDeclarations(loaded.result, recorded.bytes) : undefined
            if (change.kind === 'unrecorded' || change.kind === 'widening' && !approved) return unavailable(guardHeld(identity,
                `${identity.configPath} changed since the guards were generated and ${guardConfigHeldReason(change)}`,
                'guard policy comes from it and an edit that may widen it takes effect only once a human approves it'))
            if (change.kind === 'widening' && approved) {
                declared = approved
                notice = ` ${identity.configPath} has an unapproved edit that widens what agents may do (${change.fields.join(', ')}); calls are judged under the configuration last synced until a person runs \`${installedSyncCommand(identity.root, identity.configPath)} --interactive\` in a terminal, outside the agent, and confirms it.`
            }
        }
        const widening = notice !== ''
        const config = declared.config
        const authenticated = await authenticatePublication(publicationPending, config.cockpit.name)
        if (authenticated.held) return authenticated.held
        const { publication, manifestRead, published } = authenticated
        const git = await adapters.resolveGit()
        if (git.state !== 'available') return unavailable('Guard checkout observation requires an authenticated Git executable.')
        const checkout = await adapters.observeCheckout({ source: loaded.result.source, cockpitName: config.cockpit.name,
            observedAt: new Date().toISOString(), env: {}, gitExecutable: git.value })
        // Under the allow default a word the guard cannot expand is marked, not refused: the evaluator
        // refuses it only where it decides what is read, written or pushed.
        const parsed = parseGuardInput(data.payload, { dynamicWords: config.guards.default === 'allow' ? 'mark' : 'refuse', home: homedir() })
        if (parsed.status !== 'parsed') return unavailable(parsed.reason)
        // The harness reports the agent's working directory and starts the guard in a canonical one; they differ when
        // the agent's shell changed directory through a link or under another spelling.
        if (parsed.cwd !== data.cwd) return unavailable(`The call reports the working directory ${JSON.stringify(parsed.cwd)}, but the guard runs in ${JSON.stringify(data.cwd)}: `
            + `paths are judged from one directory only. Change to ${JSON.stringify(data.cwd)} itself, then run the command.`)
        // The policy pin and the restoration both apply an edit to exactly these bytes, which must be the text the policy is built from.
        const configRead = publication.get(configName)!
        if (configRead.sha256 !== configSha256) return unavailable('Guard configuration changed during evaluation.')
        const configText = configRead.bytes.toString('utf8')
        const restoring = unsynced && restoresRecordedConfiguration(parsed, configText, identity.configPath, identity.configSha256)
        const prepared = await prepareGuardEvaluationPolicy({ configuration: declared, checkout }, checkoutsPending.then(unwrap))
        if (prepared.kind !== 'complete') {
            if (restoring) return restored
            return unsynced && !widening
                ? unbuildableEdit(identity, prepared.diagnostics[0]?.message ?? 'no reason given')
                : unavailable(checkout.state === 'available'
                    ? `Guard policy authority could not be authenticated: ${prepared.diagnostics[0]?.message ?? 'no reason given'}`
                    : prepared.diagnostics[0]?.message ?? 'Guard checkout observation failed without a reason.')
        }
        // The inspector answers synchronously, so what only Git can say is asked first: which protected
        // paths a default ripgrep search reads, and which a repository's index holds for a Git command
        // that prints committed content. A request not asked here gets the walk, or no answer.
        const policy = prepared.result.policy
        const instancePaths = policy.instances.map(item => item.path)
        // What Git is asked to list beside environment and secrets names: every declared instance and secret path.
        const watchedPaths = [...instancePaths, ...policy.secretPaths ?? []]
        const present = (path: string) => { try { lstatSync(path); return true } catch (error) { if (hasErrorCode(error, 'ENOENT', 'ENAMETOOLONG')) return false; throw error } }
        const allowed = (path: string) => policy.allowedRoots.some(root => confinedPath(root, path))
        // These are exact observation requests, never roots for mutation or arbitrary execution.
        const approvedReads = new Set<string>()
        const approvedDirectories = new Set<string>()
        // A Git command requires its repository directory, which it reads through Git, not as content.
        const approvedRequirements = new Set<string>()
        for (const invocation of parsed.invocations) {
            const access = approvedReadOnlyInvocation(invocation, { ...policy, ripgrepConfigActive: data.ripgrepConfigActive === true })
            if (!access) continue
            for (const path of [...access.reads, ...access.trees, ...access.listings]) approvedReads.add(resolve(access.cwd, path))
            for (const path of access.requires ?? []) approvedRequirements.add(resolve(access.cwd, path))
            if (access.cwd !== invocation.cwd) approvedDirectories.add(access.cwd)
        }
        // Native external reads leave a read-only Git command to the agent tool, so its repository outside
        // the roots is inspected as a granted one's is. The evaluator admits it only alone in the call.
        // A related checkout admits the same read-only Git there.
        const related = (path: string) => (policy.relatedCheckouts ?? []).some(root => confinedPath(root, path))
        const nativeGit = (cwd: string) => policy.externalReads === 'native' || related(cwd)
        for (const invocation of parsed.invocations) {
            const access = invocation.executable === 'git' ? classifyReadOnlyInvocation(invocation, { ripgrepConfigActive: data.ripgrepConfigActive === true }) : undefined
            if (!access || allowed(access.cwd) || !nativeGit(access.cwd)) continue
            approvedDirectories.add(access.cwd)
            for (const path of access.requires ?? []) approvedRequirements.add(resolve(access.cwd, path))
        }
        // Each entry starts as the answer for Git not answering and is replaced by Git's.
        const unignored = new Map<string, readonly string[] | null | undefined>()
        const tracked = new Map<string, readonly string[] | null>()
        const queries: Array<() => Promise<void>> = []
        // Which branch a push or a history rewrite acts on is Git's to say, in a repository inside the roots.
        // Git's answers rest on the person's global configuration too, as the agent's own Git commands do.
        const gitEnvironment = { ...typeof data.home === 'string' ? { HOME: data.home } : {}, ...typeof data.xdgConfigHome === 'string' ? { XDG_CONFIG_HOME: data.xdgConfigHome } : {} }
        const branches = new Map<string, Awaited<ReturnType<typeof guardBranchFacts>>>()
        // Whether a remote URL Git prints carries a credential, for `git remote -v` and a read of `.git/config`.
        const remotes = new Map<string, boolean | null>()
        const askRemotes = (repository: string) => {
            if (!allowed(repository) || remotes.has(repository)) return
            remotes.set(repository, null)
            queries.push(async () => { remotes.set(repository, await guardRemoteCredentials(repository, git.value, adapters.execute ?? executeProbe, gitEnvironment)) })
        }
        // What a merge, checkout, reset, pick, rebase, stash or pull writes into a work tree holding a
        // guard control: Git compares the revisions before the command runs.
        const protectedPaths = [...GUARD_ROOT_PROTECTIONS.map(item => join(policy.canonicalRoot, item.path)), ...watchedPaths]
        const trees = new Map<string, Awaited<ReturnType<typeof guardWorktreeChanges>>>()
        const treeKey = (cwd: string, revision: string, from: string | undefined) => `${cwd}\0${revision}\0${from ?? ''}`
        for (const invocation of parsed.invocations) {
            const command = gitInvocation(invocation)
            for (const target of command && !command.uncertain && allowed(command.cwd) ? gitTreeTargets(command)?.targets ?? [] : []) {
                const key = treeKey(command!.cwd, target.revision, target.from)
                if (trees.has(key)) continue
                trees.set(key, null)
                queries.push(async () => { trees.set(key, await guardWorktreeChanges(command!.cwd, target, protectedPaths, git.value, adapters.execute ?? executeProbe, gitEnvironment)) })
            }
        }
        for (const invocation of parsed.invocations) {
            const command = gitInvocation(invocation)
            if ((command?.verb === 'remote' || command?.verb === 'ls-remote') && !command.uncertain) askRemotes(command.cwd)
            for (const path of classifyReadOnlyInvocation(invocation, { ripgrepConfigActive: data.ripgrepConfigActive === true })?.reads ?? []) {
                const read = resolve(invocation.cwd, path)
                if (foldGuardSpelling(basename(read)) === 'config' && foldGuardSpelling(basename(dirname(read))) === '.git') askRemotes(dirname(dirname(read)))
            }
            if (!command || !GUARD_BRANCH_VERBS.has(command.verb) || command.uncertain || !allowed(command.cwd) || branches.has(command.cwd)) continue
            branches.set(command.cwd, null)
            queries.push(async () => { branches.set(command.cwd, await guardBranchFacts(command.cwd, git.value, adapters.execute ?? executeProbe, gitEnvironment)) })
        }
        for (const invocation of parsed.invocations) {
            const access = classifyReadOnlyInvocation(invocation, { ripgrepConfigActive: data.ripgrepConfigActive === true })
            if (access?.trackedContent && (allowed(access.cwd) || nativeGit(access.cwd) && parsed.invocations.length === 1) && !tracked.has(access.cwd)) {
                tracked.set(access.cwd, null)
                queries.push(async () => { tracked.set(access.cwd, await guardTrackedSensitivePaths(access.cwd, watchedPaths, git.value, adapters.execute ?? executeProbe)) })
            }
            for (const tree of access?.skipsIgnored ? access.trees : []) {
                const path = resolve(access!.cwd, tree)
                if (!allowed(path) || unignored.has(path) || !present(path) || realpathSync(path) !== path) continue
                unignored.set(path, undefined)
                queries.push(async () => { unignored.set(path, await guardUnignoredSensitivePaths(path, watchedPaths, git.value, adapters.execute ?? executeProbe)) })
            }
        }
        // A query starts up to four Git processes, so a command naming many trees is asked about a few
        // at a time, and a failed one stops the rest from starting.
        const worker = async () => {
            for (let query = queries.shift(); query; query = queries.shift()) await query().catch((error: unknown) => { queries.length = 0; throw error })
        }
        await Promise.all([worker(), worker(), worker(), worker()])
        const walks = new Map<string, readonly string[] | null>()
        const searched = (path: string, unignoredOnly: boolean, followsLinks: boolean): readonly string[] | null => {
            const listed = unignoredOnly ? unignored.get(path) : undefined
            if (listed !== undefined) return listed
            const key = `${followsLinks}\0${path}`
            let walked = walks.get(key)
            if (walked === undefined) walks.set(key, walked = guardSensitivePathsBelow(path, undefined, followsLinks))
            // The walk names environment and secrets names; an ignore-aware search also needs the instances it reads.
            if (!unignoredOnly || walked === null) return walked
            const found = [...new Set([...walked, ...watchedPaths.filter(item => confinedPath(path, item) && present(item))])].sort()
            return found.length > GUARD_LOCATION_LIMITS.sensitivePaths ? null : found
        }
        const inspected = new Map<string, Stats>()
        const readLinks = new Map<string, string>()
        // The system resolves `..` from where a link leads, so `link/../x` names a sibling of the link's
        // target, not of the link: a spelling that leaves a link through `..` is not its lexical path.
        const leavesLink = (cwd: string, spelled: string) => {
            let cursor = isAbsolute(spelled) ? '/' : cwd
            for (const component of spelled.split('/')) {
                if (component === '..') {
                    try {
                        const status = lstatSync(cursor)
                        if (status.isSymbolicLink()) return true
                        inspected.set(cursor, status)
                    } catch (error) {
                        // A missing, non-directory or overlong component fails the system's lookup before `..` applies.
                        if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ENAMETOOLONG')) throw error
                    }
                    cursor = dirname(cursor)
                } else if (component && component !== '.') cursor = join(cursor, component)
            }
            return false
        }
        const inspect: import('../../guards/evaluator.js').PathInspection = request => {
            const path = resolve(request.cwd, request.path)
            if (request.operation === 'branch') {
                const facts = branches.get(path)
                return facts ? { status: 'resolved', path, ...facts } : { status: 'unavailable', path, symlink: false }
            }
            if (request.operation === 'remote') {
                const credentials = remotes.get(path)
                return typeof credentials === 'boolean' ? { status: 'resolved', path, credentials } : { status: 'unavailable', path, symlink: false }
            }
            if (request.operation === 'patch') {
                const targets = allowed(path) ? guardPatchTargets(path) : null
                return targets ? { status: 'resolved', path, targets } : { status: 'unavailable', path, symlink: false }
            }
            if (request.operation === 'tree') {
                const facts = request.revision === undefined ? null : trees.get(treeKey(path, request.revision, request.from))
                return facts ? { status: 'resolved', path, revision: request.revision, ...request.from === undefined ? {} : { from: request.from }, ...facts }
                    : { status: 'unavailable', path, symlink: false }
            }
            if (request.operation === 'external-write') {
                // Where a write outside the roots lands: the deepest existing ancestor through its links, then the rest as spelled.
                let cursor = path
                const rest: string[] = []
                for (;;) {
                    try { lstatSync(cursor); break }
                    catch (error) {
                        if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR') || cursor === '/') throw error
                        rest.unshift(basename(cursor))
                        cursor = dirname(cursor)
                    }
                }
                return { status: 'resolved', path, landsAt: join(realpathSync(cursor), ...rest) }
            }
            if (request.operation === 'manifest') {
                const manifest = allowed(path) ? guardPackageManifest(path, allowed, request.workspace === true) : null
                return manifest ? { status: 'resolved', path, ...manifest } : { status: 'unavailable', path, symlink: false }
            }
            const managedRoot = policy.allowedRoots.filter(root => confinedPath(root, path)).sort((a, b) => b.length - a.length)[0]
            const reading = ['read', 'list', 'search', 'unignored-search'].includes(request.operation)
            // A related checkout is read as a root is: a named file, a listing or a search walked for secrets.
            const relatedRoot = !managedRoot && reading ? policy.relatedCheckouts?.find(root => confinedPath(root, path)) : undefined
            // A person's read path admits this read, or with native external reads the agent tool's own permission decided it.
            const declaredRead = !managedRoot && reading
                && (policy.externalReads === 'native' || (policy.readPaths ?? []).some(root => confinedPath(root, path)))
            const externalRead = reading && (approvedReads.has(path) || approvedRequirements.has(path)) || declaredRead
                || request.operation === 'cwd' && approvedDirectories.has(path) || request.operation === 'repository' && tracked.has(path)
            const root = managedRoot ?? relatedRoot ?? (externalRead ? '/' : undefined)
            if (!root) return { status: 'unavailable', path, symlink: false }
            if (leavesLink(request.cwd, request.path)) return { status: 'resolved', path, symlink: true }
            let cursor = root
            const rootStatus = lstatSync(root)
            inspected.set(root, rootStatus)
            // Identities let the evaluator recognise a protected entry under any spelling the volume
            // resolves to it; a missing leaf reports its nearest existing ancestors only.
            const chain = [guardIdentity(rootStatus)]
            let exists = true
            for (const component of relative(root, path).split(sep).filter(Boolean)) {
                cursor = join(cursor, component)
                let status: Stats
                try { status = lstatSync(cursor) }
                catch (error) {
                    // A component longer than the volume allows names nothing, as a missing one does, and
                    // neither does one below a file: `mv a docs/page.md` names `docs/page.md/a` only in case
                    // the destination were a directory.
                    if (hasErrorCode(error, 'ENOENT', 'ENAMETOOLONG', 'ENOTDIR')) { exists = false; break }
                    throw error
                }
                if (status.isSymbolicLink()) {
                    // Package managers link installed packages into a store inside the checkout. A named
                    // file read, or a search of a file or directory, follows that link to a target inside
                    // the roots and is judged there, a search by the same secret walk as any other. A working
                    // directory does not: its relative paths and program paths resolve where the link leads.
                    // External grants never follow one.
                    if (managedRoot && ['read', 'search', 'unignored-search'].includes(request.operation)) {
                        inspected.set(cursor, status)
                        const target = realpathSync(path)
                        const leads = allowed(target) ? lstatSync(target) : undefined
                        if (leads && (leads.isFile() || request.operation !== 'read' && leads.isDirectory())) {
                            readLinks.set(path, target)
                            const evidence = inspect({ ...request, path: target })
                            if (evidence && typeof evidence === 'object') return { ...evidence, path, canonicalPath: target }
                        }
                    }
                    return { status: 'resolved', path, symlink: true }
                }
                inspected.set(cursor, status)
                chain.push(guardIdentity(status))
            }
            // Outside the managed roots the walk recognises only `.env*` and `.secrets` names, not other
            // credential files, so an approved external read or search names a regular file, never a tree.
            if (!managedRoot && !relatedRoot && !['cwd', 'repository'].includes(request.operation) && !approvedRequirements.has(path) && exists && !inspected.get(path)!.isFile()
                && !(request.operation === 'list' && inspected.get(path)!.isDirectory())) return { status: 'unavailable', path, symlink: false }
            const search = request.operation === 'search' || request.operation === 'unignored-search'
            return { status: 'resolved', path, symlink: false, identity: exists ? chain.at(-1)! : null, ancestors: exists ? chain.slice(0, -1) : chain,
                ...(search ? { sensitive: exists ? searched(path, request.operation === 'unignored-search', request.followsLinks === true) : [] } : {}),
                ...(request.operation === 'repository' ? { tracked: tracked.get(path) ?? null } : {}) }
        }
        const cockpitInvocations: GuardInvocationProfile[] = []
        const launcher = resolve(dirname(identity.module), '../bin/cockpit.mjs')
        const searchPath = data.searchPath ?? ''
        // Skills and fix hints print the installed entrypoint, and people also run `npx --no cockpit …` and
        // the bin link; every spelling counts as the launcher only where it provably starts this installation.
        type Launched = { readonly executable: string; readonly cwd: string; readonly argv: readonly string[]; readonly prefix: number; readonly session: boolean }
        const launched: Launched[] = []
        const prove = (executable: string | null, cwd: string, argv: readonly string[], session: boolean) => {
            const prefix = executable === null ? undefined : cockpitLauncherPrefix(executable, argv)
            const evidence = prefix === undefined ? undefined : guardLauncherEvidence(executable!, argv.slice(0, prefix), cwd, identity.root, launcher, searchPath)
            if (evidence === undefined) return undefined
            inspected.set(evidence, lstatSync(evidence))
            const proven = { executable: executable!, cwd, argv, prefix: prefix!, session }
            launched.push(proven)
            return proven
        }
        const configured = { canonicalRoot: identity.root, configPath: identity.configPath, profiles: agentProfiles(config) }
        for (const { executable, cwd, argv } of parsed.invocations) {
            const proven = prove(executable, cwd, argv, true)
            // The evaluator judges a session's command as one more invocation, so its spelling needs proof too.
            const inner = proven && ordinarySessionCommand(argv.slice(proven.prefix), cwd, configured)
            if (inner) prove(inner[0]!, cwd, inner.slice(1), false)
        }
        // Sync or upgrade would apply a widening edit, and the person reviews that edit first.
        const applying = widening ? launched.find(entry => ['sync', 'upgrade'].includes(commandSpelling(entry.argv.slice(entry.prefix)).name ?? '')) : undefined
        if (applying) return refused({ decision: 'deny', reason: `Refusing to run cockpit ${commandSpelling(applying.argv.slice(applying.prefix)).name} while ${identity.configPath} has an unapproved edit that widens what agents may do: a person reviews it and syncs.` })
        // A spelling the guard cannot prove starts the installed cockpit, such as a path into the package
        // through `/./` or another case, still runs it: any cockpit command naming sync or upgrade is held too.
        const packages = [...policy.cockpitPackageDirectories ?? [], ...policy.executionDirectories]
        const unproven = widening ? parsed.invocations.find(invocation => cockpitShaped(invocation, packages)
            && [invocation.executable ?? '', ...invocation.argv].some(word => /(?:^|:)(?:sync|upgrade)$/.test(word))) : undefined
        if (unproven) return refused({ decision: 'deny', reason: `Refusing to run cockpit ${[unproven.executable ?? '', ...unproven.argv].find(word => /(?:^|:)upgrade$/.test(word)) ? 'upgrade' : 'sync'} while ${identity.configPath} has an unapproved edit that widens what agents may do: a person reviews it and syncs.` })
        let launcherSha256: string | undefined
        if (launched.length) {
            const status = lstatSync(launcher)
            if (!status.isFile() || status.isSymbolicLink() || !(status.mode & 0o111) || realpathSync(launcher) !== launcher) {
                return unavailable('Guard ordinary command executable is unavailable or ambiguous.')
            }
            launcherSha256 = (await read(dirname(launcher), basename(launcher), 65_536)).sha256
            inspected.set(launcher, status)
            const services = await guardServiceIds(config, identity.root,
                { node, resolveDocker: adapters.resolveDocker, execute: adapters.execute ?? executeProbe })
            if (typeof services === 'string') return unavailable(`Guard could not read the Compose service list: ${services}`)
            const authority = { executable: launcher, ...configured, allowedRoots: prepared.result.policy.allowedRoots, services,
                gates: config.testing?.gates.map(gate => gate.id) ?? [], grants: ordinaryGrants(config) }
            for (const { executable, cwd, argv, prefix, session } of launched) {
                const args = argv.slice(prefix)
                // A session inside a session would run a command the evaluator never sees.
                const admitted: Pick<GuardInvocationProfile, 'reads' | 'alone'> | undefined = session && ordinarySessionCommand(args, cwd, configured) ? {}
                    : resolveOrdinaryInvocation({ executable: launcher, cwd, argv: args }, authority, path => {
                        const fact = inspect({ path, cwd, operation: 'write' })
                        return !!fact && typeof fact === 'object' && 'status' in fact && fact.status === 'resolved'
                            && 'symlink' in fact && fact.symlink === false
                    })
                // The evaluator matches the invocation as the agent spelled it, and checks what it reads.
                if (admitted) cockpitInvocations.push({ executable, cwd, argv, ...(admitted.reads ? { reads: admitted.reads } : {}), ...(admitted.alone ? { alone: true as const } : {}) })
            }
        }
        if (cockpitInvocations.length + prepared.result.policy.projectCommands.length > GUARD_INPUT_LIMITS.invocations) return unavailable('Guard candidates exceed the invocation bound.')
        const configStatus = lstatSync(identity.configPath)
        // A hard link or another spelling of the configuration is the configuration.
        const isConfig = (path: string) => {
            if (foldGuardSpelling(path) === foldGuardSpelling(identity.configPath)) return true
            let status: Stats | undefined
            try { status = lstatIfPresentSync(path) } catch (error) { throw new CallPathUnreadable(path, error) }
            return status !== undefined && status.dev === configStatus.dev && status.ino === configStatus.ino
        }
        // Restoring removes whatever the edit added, including a restriction the pin would otherwise keep.
        const pinned = restoring ? undefined : pinnedPolicyDenial(parsed, configText, isConfig)
        if (pinned) return refused(pinned)
        const decision = evaluateGuard(parsed, { ...prepared.result.policy, cockpitInvocations,
            mcpAllowedTools: config.mcp.allowed_tools,
            cockpitLaunchers: launched.map(({ executable, cwd, argv, prefix }) => ({ executable, cwd, argv: argv.slice(0, prefix) })),
            searchDirectories: guardSearchDirectories(searchPath, prepared.result.policy.allowedRoots),
            // Native external writes still never plant a program in a search path directory outside the roots.
            ...policy.externalWrites === 'native' ? { externalSearchDirectories: externalSearchDirectories(searchPath, policy.allowedRoots) } : {},
            searchPathRelativeEntry: guardSearchPathRelativeEntry(searchPath),
            ripgrepConfigActive: data.ripgrepConfigActive === true }, inspect)
        const current = await adapters.loadConfig(identity.configPath)
        if (current.kind !== 'complete' || current.result.source.sha256 !== configSha256) return unavailable('Guard configuration changed during evaluation.')
        for (const [path, before] of [...roots, ...inspected]) {
            const after = lstatSync(path)
            // Directories may receive unrelated leaves, but replacement and file changes invalidate evidence.
            if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
                || before.isFile() && (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size)) return unavailable('Guard filesystem authority changed during evaluation.')
        }
        for (const [path, target] of readLinks) if (realpathSync(path) !== target) return unavailable('Guard read link target changed during evaluation.')
        const currentPublication = await readPublication()
        for (const [path, hash] of [[manifestPath, manifestRead.sha256], [GUARD_LOCAL_PATHS.identity, publication.get(GUARD_LOCAL_PATHS.identity)!.sha256], ...published] as const) {
            if (currentPublication.get(path)!.sha256 !== hash) return unavailable('Guard publication changed during evaluation.')
        }
        if ((await read(dirname(identity.module), basename(identity.module), 16_777_216)).sha256 !== identity.moduleSha256) return unavailable('Guard handler changed during evaluation.')
        if (launcherSha256 && (await read(dirname(launcher), basename(launcher), 65_536)).sha256 !== launcherSha256) return unavailable('Guard ordinary command executable changed during evaluation.')
        return refused(decision)
    } catch (error) {
        if (error instanceof CallPathUnreadable) return unavailable(error.message)
        return unavailable(`Guard authority could not be read or revalidated: ${errorCause(error)}`)
    }
}

/** Absolute command search path directories, as spelled and as resolved, that lie outside every managed root. */
function externalSearchDirectories(searchPath: string, roots: readonly string[]): readonly string[] {
    const found = new Set<string>()
    for (const entry of searchPath.split(':')) {
        if (!entry.startsWith('/')) continue
        const spelled = resolve(entry)
        const candidates = [spelled]
        try { candidates.push(realpathSync(spelled)) } catch (error) { if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) throw error }
        for (const candidate of candidates) if (candidate !== '/' && !roots.some(root => confinedPath(root, candidate))) found.add(candidate)
    }
    if (found.size > 256) throw new RefusalError('guard search path exceeds 256 directories outside the allowed roots')
    return [...found].sort()
}

// The guard runs against the configuration sync generated it from, or one that does not widen it, so
// the policy read here grants nothing the last sync did not.
function ordinaryGrants(config: CockpitConfig): readonly OrdinaryGrant[] {
    const policy = effectivePolicy(config)
    return [...config.browser && browserPreapprovalRequested(config.browser) ? ['browser-preapproval' as const] : [],
        ...policy.autonomy.sync === 'agent' ? ['autonomy-sync' as const] : [], ...policy.autonomy.reset === 'agent' ? ['autonomy-reset' as const] : [],
        ...policy.autonomy.instruction_files === 'agent' ? ['autonomy-instruction-files' as const] : []]
}

// `up --profile` and `session --profile` start that profile's services for one run. Only the default
// set a person declared is theirs to name, and a profile that mounts an operator-gated sibling, which
// touches live data or local hardware, never starts without a person.
function agentProfiles(config: CockpitConfig): readonly string[] {
    return config.environment.profiles.filter(profile => !config.sibling.some(row => row.gate === 'operator' && row.mount === `profile:${profile}`))
}

type SiblingRoot = Readonly<{ sibling: CockpitConfig['sibling'][number]; index: number; root: string }>

/**
 * Every checkout the guard grants for a sibling: each declared directory, then each checkout `use`
 * recorded, which is where the agent works on that sibling. A recorded checkout that is gone grants
 * nothing. Allowed roots, instance protection and project commands all come from this one list.
 */
function siblingRoots(config: CockpitConfig, siblingsRoot: string, served: ReadonlyMap<string, ServedSibling>): readonly SiblingRoot[] {
    const declared = config.sibling.map((sibling, index) => {
        const root = resolve(siblingsRoot, sibling.dir)
        if (!confinedPath(siblingsRoot, root)) throw new RefusalError('guard policy sibling escapes its declared root')
        return { sibling, index, root }
    })
    const recorded = declared.flatMap(({ sibling, index }) => {
        const entry = served.get(sibling.slug)
        if (!entry?.overridden) return []
        if (!lstatIfPresentSync(entry.served)?.isDirectory()) return []
        return [{ sibling, index, root: entry.served }]
    })
    return [...declared, ...recorded]
}

// A path the call names that cannot be inspected says nothing about the installed guard, so the hold
// names that path rather than the guard's own authority.
class CallPathUnreadable extends RefusalError {
    constructor(path: string, cause: unknown) {
        super(`Guard could not inspect ${forwardedReason(path)}, which this call names, so the call is held: ${errorCause(cause)}. Name a path the agent can read, or run the command in a terminal.`)
    }
}

class GuardFileMissing extends RefusalError {
    constructor(readonly path: string) { super(`${path} is missing`) }
}

interface PreparedGuardEvaluationPolicy {
    readonly policy: GuardEvaluationPolicy
}

interface GuardEvaluationPolicyInput {
    readonly configuration: LoadedConfigProjection
    readonly checkout: SetupCheckoutObservation
}

function guardPolicyRefusal(message: string): EnvironmentCommandOutcome<PreparedGuardEvaluationPolicy> {
    return lifecycleRefusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, message, 'guard-policy')
}

/**
 * Source projections share authenticated authority; installed consumption is admitted separately.
 * `siblingCheckouts` is the configuration directory's sibling checkout record, when the caller
 * started reading it already; it is read here otherwise.
 */
export async function prepareGuardEvaluationPolicy(
    input: GuardEvaluationPolicyInput,
    siblingCheckouts?: Promise<SiblingCheckoutRecordRead>,
): Promise<EnvironmentCommandOutcome<PreparedGuardEvaluationPolicy>> {
    const inputData = ownDataValues(input, ['configuration', 'checkout'])
    const data = inputData && Object.hasOwn(inputData, 'configuration') && Object.hasOwn(inputData, 'checkout') ? inputData : undefined
    if (!data) return guardPolicyRefusal('guard policy requires own-data configuration and checkout observations')
    const configuration = data.configuration as LoadedConfigProjection
    const exposed = snapshotJson(configuration)
    const loaded = consumeLoadedConfigProjection(configuration)
    if (!loaded || !exposed || !isDeepStrictEqual(exposed, snapshotJson(loaded))) {
        return guardPolicyRefusal('guard policy configuration authority is copied, changed or already consumed')
    }
    const derived = deriveRegistry(loaded.config)
    if (derived.kind !== 'complete') return guardPolicyRefusal(`guard policy registry refused (${derived.code}): ${derived.message}`)
    const guardConfig = CockpitConfig.parse(derived.result.config)
    const recorded = await (siblingCheckouts ?? readSiblingCheckouts(dirname(loaded.source.path)))
    if (recorded.kind === 'refusal') return guardPolicyRefusal(recorded.diagnostic.message)
    const served = servedSiblings(dirname(loaded.source.path), guardConfig, recorded.checkouts)
    const observed = snapshotJson(data.checkout) as SetupCheckoutObservation | undefined
    if (observed?.state !== 'available') {
        const root = dirname(loaded.source.path)
        return guardPolicyRefusal(`Generated files stay valid, but the guard needs a Git repository it can read and holds ${GUARD_HELD_CALLS} until it has one, while ${GUARD_UNHELD_CALLS} continue: ${forwardedReason(observed?.reason ?? 'no reason given')}. Fix: in a terminal, outside the agent, run \`${formatShellCommand(['git', '-C', root, 'init'])}\` if ${root} has no repository, remove a stale .git entry or repair it with git worktree repair, and remove any include.path or includeIf entry from the repository's Git configuration; held calls then continue without a sync.`)
    }
    try {
        const identities = new Map<string, Stats>()
        let checkoutRoots: readonly SiblingRoot[] | undefined
        const result = await withSetupCheckoutProjection(data.checkout, {
            source: loaded.source, cockpitName: loaded.config.cockpit.name, evaluatedAt: Date.parse(observed.observedAt),
        }, (projection) => {
            const checkout = consumeSetupCheckoutProjection(projection)
            if (!checkout || !sameSource(checkout.source, loaded.source)) {
                return guardPolicyRefusal('guard policy checkout does not match configuration authority')
            }
            const config = guardConfig
            const protectedIdentities = new Map<string, GuardProtectedIdentity>()
            // Records the identity of every existing component so the evaluator can match a protected
            // entry by inode rather than by spelling.
            const protect = (root: string, path: string, leaf: 'file' | 'directory' | 'any', label: string) => {
                const segments = relative(root, path).split(sep)
                const chain = [guardIdentity(identities.get(root)!)]
                let cursor = root
                let exists = true
                for (const [index, segment] of segments.entries()) {
                    cursor = join(cursor, segment)
                    let status: Stats
                    try { status = lstatSync(cursor) }
                    catch (error) {
                        if (hasErrorCode(error, 'ENOENT')) { exists = false; break }
                        throw error
                    }
                    const last = index === segments.length - 1
                    if (status.isSymbolicLink() || (!last || leaf === 'directory' ? !status.isDirectory() : leaf === 'file' && !status.isFile())) {
                        throw new RefusalError(`guard policy ${label} path has a symlink or unexpected file type`)
                    }
                    identities.set(cursor, status)
                    chain.push(guardIdentity(status))
                }
                protectedIdentities.set(path, { path, identity: exists ? chain.at(-1)! : null,
                    ancestors: exists ? chain.slice(0, -1) : chain })
            }
            const directory = (path: string) => {
                const before = lstatSync(path)
                if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(path) !== path
                    || !isAbsolute(path) || path === '/' || /[\x00-\x1f\x7f]/.test(path)) {
                    throw new RefusalError('guard policy requires canonical directory authority')
                }
                identities.set(path, before)
                return path
            }
            const canonicalRoot = directory(dirname(loaded.source.path))
            checkoutRoots = siblingRoots(config, directory(resolve(canonicalRoot, config.cockpit.siblings_root)), served)
            const allowedRoots = new Set([canonicalRoot])
            const instances: Array<{ readonly name: string; readonly path: string }> = []
            const templates: string[] = []
            for (const { sibling, root } of checkoutRoots) {
                allowedRoots.add(directory(root))
                for (const file of derived.result.secretPaths.filter(row => row.slug === sibling.slug)) {
                    const path = resolve(root, file.path)
                    if (!confinedPath(root, path) || path === root) throw new RefusalError('guard policy instance escapes its sibling root')
                    protect(root, path, 'file', 'instance')
                    instances.push({ name: `${sibling.slug}-${createHash('sha256').update(file.path).digest('hex').slice(0, 12)}`, path })
                }
                for (const file of sibling.environment_files ?? []) {
                    const path = resolve(root, file.template)
                    if (!confinedPath(root, path) || path === root) throw new RefusalError('guard policy environment template escapes its sibling root')
                    templates.push(path)
                }
            }
            if (allowedRoots.size > 256 || instances.length > 256) throw new RefusalError('guard policy exceeds restriction root or instance bounds')
            // A declared secret path lies in the cockpit, or in every checkout of the sibling it names.
            const secretPaths: string[] = []
            for (const declared of config.guards.secret_paths) {
                const { slug, path: spelled } = splitRepositoryPath(declared)
                const roots = slug === undefined ? [canonicalRoot] : checkoutRoots.filter(row => row.sibling.slug === slug).map(row => row.root)
                if (!roots.length) throw new RefusalError(`guard policy secret path ${declared} names an undeclared sibling`)
                for (const root of roots) {
                    const path = resolve(root, spelled)
                    if (!confinedPath(root, path) || path === root) throw new RefusalError('guard policy secret path escapes its root')
                    if (secretPaths.includes(path)) continue
                    protect(root, path, 'any', 'secret')
                    secretPaths.push(path)
                }
            }
            for (const { path, type } of GUARD_ROOT_PROTECTIONS) protect(canonicalRoot, join(canonicalRoot, path), type, 'guard control or secrets')
            // The configuration's own identity lets the evaluator recognise its deletion under any spelling.
            const configPath = loaded.source.path
            protect(canonicalRoot, configPath, 'file', 'configuration')
            // This module runs from dist/environment, so two levels up is the running cockpit package.
            const packageRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
            const installed = guardInstalledDirectories(packageRoot, canonicalRoot)
            const executionDirectories = installed.filter(path => [...allowedRoots].some(root => confinedPath(root, path)))
            // Every spelling of the package itself, inside the roots or not, is how a command reaches cockpit's own code.
            const cockpitPackageDirectories = installed.filter(path => realpathSync(path) === realpathSync(packageRoot))
            const secretFiles = guardSecretFiles(canonicalRoot)
            const protectedFilesLinked = secretFiles.linked || instances.some(item => (identities.get(item.path)?.nlink ?? 1) > 1)
            for (const [path, before] of identities) {
                const after = lstatSync(path)
                if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
                    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) {
                    throw new RefusalError('guard policy root or instance identity changed during construction')
                }
            }
            const policy = { canonicalRoot, configPath,
                allowedRoots: [...allowedRoots], instances, templates,
                protectedIdentities: [...protectedIdentities.values()],
                protectedBranches: [...config.guards.protected_branches],
                hostedDatabaseHosts: [...config.guards.hosted_db_hosts],
                vendorHosts: [...config.guards.vendor_endpoint_hosts],
                declaredAllows: config.guards.allow.map(rule => ({ ...rule,
                    ...(rule.cwd === undefined ? {} : { cwd: resolve(canonicalRoot, rule.cwd) }), argv: [...rule.argv] })),
                declaredDenies: config.guards.deny.map(rule => ({
                    match: 'prefix' in rule ? 'prefix' as const : 'contains' as const,
                    argv: [...('prefix' in rule ? rule.prefix : rule.contains)], reason: rule.reason,
                    ...(rule.fix === undefined ? {} : { fix: rule.fix }),
                })),
                ripgrepConfigActive: false, externalReads: config.guards.external_reads, defaultDecision: config.guards.default,
                unresolved: config.guards.unresolved, externalWrites: config.guards.external_writes,
                homeDirectory: realpathSync(homedir()),
                relatedCheckouts: config.guards.related_checkouts.flatMap(spelled => {
                    const path = spelled.startsWith('~/') ? join(homedir(), spelled.slice(2)) : resolve(canonicalRoot, spelled)
                    let real: string
                    // A missing checkout grants nothing; a linked one is held to where it leads.
                    try { real = realpathSync(path) } catch (error) { if (hasErrorCode(error, 'ENOENT')) return []; throw error }
                    const home = realpathSync(homedir())
                    // The filesystem root, the home directory or a directory above it is no checkout, and one
                    // overlapping a managed root would make that root read-only.
                    if (!lstatSync(real).isDirectory() || real === '/' || confinedPath(real, home)
                        || [...allowedRoots].some(root => confinedPath(root, real) || confinedPath(real, root))) return []
                    return [real]
                }),
                readPaths: config.guards.read_paths.flatMap(({ path }) => {
                    const spelled = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
                    // A missing location grants nothing; a linked one is held to where it leads.
                    try { return [realpathSync(spelled)] } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
                }).filter(path => path !== '/' && path !== realpathSync(homedir())),
                secretPaths,
                executionDirectories, cockpitPackageDirectories, searchDirectories: [], searchPathRelativeEntry: null,
                secretFileIdentities: secretFiles.identities && [...secretFiles.identities], protectedFilesLinked,
                cockpitInvocations: [], cockpitLaunchers: [], projectCommands: [],
            }
            return { kind: 'complete' as const, status: 0 as const, diagnostics: [],
                result: { policy } }
        })
        if (!result || result.kind !== 'complete' || !checkoutRoots) {
            return result ?? guardPolicyRefusal('guard policy checkout authority is copied, changed, expired or already consumed')
        }
        const boundaries = result.result.policy
        const projectCommands: GuardProjectCommand[] = []
        for (const { index: siblingIndex, sibling, root: checkoutRoot } of checkoutRoots) {
            const policies = trustInForce(guardConfig).installPolicies
            if (!policies.some(policy => policy.toolchain === sibling.toolchain && (policy.build || policy.test))) continue
            const checkoutId = deriveCheckoutId({ checkoutPath: checkoutRoot })
            const evaluatedAt = Date.now()
            const observation = await observeInstallPolicyLockfiles({ source: loaded.source, siblingIndex, siblingSlug: sibling.slug,
                checkoutRoot, checkoutId, policies, observedAt: new Date(evaluatedAt).toISOString() })
            const resolution = await withInstallPolicyProjection(observation, {
                source: loaded.source, siblingIndex, siblingSlug: sibling.slug, checkoutRoot, checkoutId, policies, evaluatedAt,
            }, projection => resolveInstallPolicies({ source: loaded.source, siblingIndex, sibling, checkoutRoot, checkoutId, policies, projection }))
            if (resolution?.kind !== 'complete' || resolution.bindings.length !== 1) {
                return guardPolicyRefusal(`guard project command policy is unavailable for ${sibling.slug}`)
            }
            for (const kind of ['build', 'test'] as const) {
                const argv = resolution.bindings[0]!.policy[kind]
                if (!argv) continue
                if (renderGuardProjectCommand(argv).kind !== 'complete') return guardPolicyRefusal(`guard ${kind} command exceeds its rendering bound`)
                projectCommands.push({ executable: argv[0]!, checkoutRoot, kind, argv: argv.slice(1) })
            }
        }
        if (projectCommands.length > GUARD_INPUT_LIMITS.invocations) return guardPolicyRefusal('guard candidates exceed the invocation bound')
        const current = await loadCockpitConfig(loaded.source.path)
        const revalidated = current.kind === 'complete' ? consumeLoadedConfigProjection(current.result) : undefined
        if (!revalidated || !sameSource(revalidated.source, loaded.source)) return guardPolicyRefusal('guard configuration source changed during command construction')
        for (const [path, before] of identities) {
            const after = lstatSync(path)
            if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
                || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) {
                return guardPolicyRefusal('guard root or instance identity changed during command construction')
            }
        }
        const policy: GuardEvaluationPolicy = { ...boundaries, projectCommands }
        return { kind: 'complete', status: 0, diagnostics: [], result: { policy } }
    } catch (error) {
        return guardPolicyRefusal(`guard policy construction failed: ${errorCause(error)}`)
    }
}
