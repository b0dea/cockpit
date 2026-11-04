import { createHash } from 'node:crypto'
import { lstatIfPresentSync } from '../presence.js'
import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
} from '../contract.js'
import { GUARD_EXECUTABLE_SEARCH_PATH, type ExecutableResolution, type ResolvedExecutable } from '../executable.js'
import { browserPreapprovalRequested, CockpitConfig } from '../../schema.js'
import { pinnedPolicyDenial } from '../../guards/policy-pin.js'
import { guardConfigChange, guardConfigHeldReason } from '../../guards/policy-change.js'
import {
    evaluateGuard,
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
import { commandSpelling, ordinarySessionCommand, resolveOrdinaryInvocation, UNSYNCED_ADMITTED_COMMANDS, UNSYNCED_ADMITTED_PROSE, type OrdinaryGrant } from '../../command-table.js'
import { effectivePolicy } from '../../autonomy.js'
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
    guardTrackedSensitivePaths,
    guardUnignoredSensitivePaths,
} from '../../guards/protected-locations.js'
import { classifyReadOnlyInvocation, cockpitLauncherPrefix } from '../../guards/read-only.js'
import { fileFingerprint, recordVerifiedDigest } from '../../environment-exec/verified-digest.js'
import { isGuardSurfaceTarget, type GuardSurfaceTarget } from '../../surfaces/harness-registry.js'
import { cockpitCommand, formatShellCommand, type FixContext } from '../../fix-catalogue.js'
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
import { loadCockpitConfig, consumeLoadedConfigProjection, STRUCTURED_INPUT_BYTE_LIMIT, type LoadedConfigProjection } from '../../config/load.js'
import { deriveRegistry } from '../../registry-derivation.js'
import { confinedPath, lifecycleRefusal, ownDataValues, sameSource } from './shared.js'
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

// Every refusal below holds all of the agent's calls, `git restore` included, so each says what
// failed, why that blocks everything, and the human action that clears it. Regeneration is a human
// step on purpose: guard policy comes from cockpit.toml, and an agent able to apply its own edit
// could loosen its guard.
type GuardFix = { readonly kind: 'sync' } | { readonly kind: 'restore'; readonly path: string }
function guardHeld(identity: GuardHandlerIdentity, what: string, why: string, fix: GuardFix): string {
    const sync = `\`${cockpitCommand('sync', { config: identity.configPath })}\` in a terminal, outside the agent`
    const action = fix.kind === 'sync' ? `a human must run ${sync}, then commit any regenerated files`
        : `a human must restore it with \`${formatShellCommand(['git', '-C', identity.root, 'restore', '--', fix.path])}\` (it is committed), or run ${sync}`
    return `${what}; ${why}, so every tool call is held, including a sync run through this agent. Fix: ${action}.`
}

// An edit that does not widen what agents may do needs only a sync, which the agent may run itself;
// every other call waits for it, so no call is judged under a policy sync has not published.
function unsyncedHold(identity: GuardHandlerIdentity, detail: string): GuardEvaluationApplicationResult {
    const sync = cockpitCommand('sync', { config: identity.configPath })
    const reason = `${identity.configPath} changed since the guards were generated without widening what agents may do${detail}; every tool call except ${UNSYNCED_ADMITTED_PROSE} is held until it is synced. Fix: run \`${sync}\` (this agent may run it where [autonomy] sync = "agent"), then commit any regenerated files.`
    return { decision: { decision: 'unavailable', reason }, diagnostics: [{ severity: 'error', target: 'guard', message: reason,
        code: 'GUARD_CONFIG_UNSYNCED' as const satisfies typeof ENVIRONMENT_CODES.GUARD_CONFIG_UNSYNCED,
        fix: `run ${sync}; an agent may run it where [autonomy] sync = "agent"` }] }
}

const GUARD_RESTORABLE = new Set(['.cockpit/generated-environment-ownership.json', '.cockpit/guards/bash-guard.sh',
    '.claude/settings.json', '.codex/hooks.json', '.opencode/plugin/cockpit-guards.js'])

/** Installed bytes are authority only while their source, roots and publication still match. */
export async function runGuardEvaluationApplication(
    input: GuardEvaluationApplicationInput,
    adapters: GuardEvaluationApplicationAdapters,
): Promise<GuardEvaluationApplicationResult> {
    const unavailable = (reason: string): GuardEvaluationApplicationResult => ({
        decision: { decision: 'unavailable', reason },
        diagnostics: [{ severity: 'error', code: 'GUARD_AUTHORITY_UNAVAILABLE', message: reason, target: 'guard' }],
    })
    try {
        const data = ownDataValues(snapshotJson(input), ['cwd', 'guardRoot', 'harness', 'identity', 'payload'], ['askIsDeny', 'ripgrepConfigActive', 'searchPath'])
        if (!data
            || data.searchPath !== undefined && (typeof data.searchPath !== 'string' || /[\x00-\x1f\x7f]/.test(data.searchPath) || Buffer.byteLength(data.searchPath) > GUARD_INPUT_LIMITS.inputBytes)
            || data.askIsDeny !== undefined && typeof data.askIsDeny !== 'boolean'
            || data.ripgrepConfigActive !== undefined && typeof data.ripgrepConfigActive !== 'boolean'
            || !isGuardSurfaceTarget(data.harness)) return unavailable('Guard request is malformed.')
        const harness = data.harness
        const captured = ownDataValues(snapshotJson(data.identity), ['root', 'rootDevice', 'rootInode', 'configPath', 'configSha256', 'configDevice', 'configInode', 'node', 'nodeSha256', 'nodeFingerprint', 'module', 'moduleSha256'])
        if (!captured
            || !Object.values(captured).every(value => typeof value === 'string')
            || !['configSha256', 'nodeSha256', 'moduleSha256'].every(key => /^[a-f0-9]{64}$/.test(String(captured[key])))) return unavailable('Installed guard identity is missing or malformed.')
        const identity = captured as unknown as GuardHandlerIdentity
        if ([identity.root, identity.configPath, identity.node, identity.module].some(path => !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f-\x9f]/.test(path))
            || dirname(identity.configPath) !== identity.root || typeof data.cwd !== 'string' || realpathSync(data.cwd) !== data.cwd
            // A local identity copied from another checkout would evaluate this one under that one's policy.
            || data.guardRoot !== identity.root
            ) return unavailable('Installed guard location does not match this application.')
        const configFile = relative(identity.root, identity.configPath)
        const changed = (what: string) => unavailable(guardHeld(identity, `${what} since the guards were generated`,
            'the guard trusts only the cockpit, Node and configuration it was generated for', { kind: 'sync' }))
        if (realpathSync(fileURLToPath(new URL('../../../dist/cli.js', import.meta.url))) !== identity.module) return changed('a different cockpit installation is running')
        const roots = new Map<string, Stats>()
        for (const [path, directory] of [[identity.root, true], [identity.configPath, false]] as const) {
            let status: Stats
            try { status = lstatSync(path) }
            catch (error) {
                if (hasErrorCode(error, 'ENOENT') && !directory) return unavailable(guardHeld(identity,
                    `${identity.configPath} is missing`, 'guard policy comes from it', { kind: 'restore', path: configFile }))
                throw error
            }
            // The configuration is authenticated by its content digest below. Holding on its inode
            // as well refused the identical bytes that `git restore`, `sed -i` and editors that save
            // by rename leave in a new file, until a human ran sync for no change.
            if (status.isSymbolicLink() || (directory ? !status.isDirectory() : !status.isFile())
                || directory && (String(status.dev) !== identity.rootDevice || String(status.ino) !== identity.rootInode)
                || realpathSync(path) !== path) {
                return changed(directory ? `the cockpit checkout ${path} was moved or replaced` : `${path} was replaced by a link or a non-file`)
            }
            roots.set(path, status)
        }
        // Re-hashing a 100 MB Node binary in every guard process dominated each call. The local record
        // carries the fingerprint sync hashed; an identical device, inode, size, mode and timestamps
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
        const readPublication = async () => {
            const batch = await readAnchoredBatches(identity.root, publicationRequests, node, { execute: adapters.execute ?? executeProbe })
            if (batch?.kind !== 'complete' || batch.results.length !== publicationRequests.length) throw new RefusalError('Guard publication read could not be authenticated.')
            return new Map(publicationRequests.map((request, index) => {
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
        if (module.sha256 !== identity.moduleSha256) return changed('the installed cockpit version changed (its handler bytes differ)')
        const loaded = unwrap(await configPending)
        if (loaded.kind !== 'complete' || loaded.result.source.path !== identity.configPath) {
            return unavailable(guardHeld(identity, `${identity.configPath} changed since the guards were generated`,
                'guard policy comes from it and an edit takes effect only once a human approves it', { kind: 'sync' }))
        }
        // Every check below runs against the configuration on disk; an edit since sync is admitted
        // only when it does not widen the one the guards were generated from, and then only for sync.
        const configSha256 = loaded.result.source.sha256
        const unsynced = configSha256 !== identity.configSha256
        if (unsynced) {
            const local = (path: string) => readAnchoredFile(identity.root, path, STRUCTURED_INPUT_BYTE_LIMIT, node, { execute: adapters.execute ?? executeProbe })
            const [recorded, confirmations] = await Promise.all([local(GUARD_LOCAL_PATHS.generatedConfig), local(ANSWER_CONFIRMATION_PATH)])
            const change = guardConfigChange(identity.configSha256, recorded.kind === 'complete' ? recorded.bytes : undefined,
                { sha256: configSha256, config: loaded.result.config }, confirmations.kind === 'complete' ? confirmations.bytes : undefined)
            if (change.kind === 'widening' || change.kind === 'unrecorded') return unavailable(guardHeld(identity,
                `${identity.configPath} changed since the guards were generated and ${guardConfigHeldReason(change)}`,
                'guard policy comes from it and an edit that may widen it takes effect only once a human approves it', { kind: 'sync' }))
        }
        const config = loaded.result.config
        let publication: Awaited<ReturnType<typeof readPublication>>
        try { publication = unwrap(await publicationPending) }
        catch (error) {
            if (!(error instanceof GuardFileMissing)) throw error
            return unavailable(GUARD_RESTORABLE.has(error.path)
                ? guardHeld(identity, `${error.path} is missing`, 'it authenticates the guard and the hook that launches it', { kind: 'restore', path: error.path })
                : guardHeld(identity, `${error.path} is missing`, 'it records the Node executable and cockpit handler on this machine, which committed files cannot carry', { kind: 'sync' }))
        }
        const local = parseGuardLocalIdentity(publication.get(GUARD_LOCAL_PATHS.identity)!.bytes.toString('utf8'))
        if (!local || !isDeepStrictEqual(local, identity)) return unavailable('Installed guard identity does not match its machine-local record.')
        const manifestRead = publication.get(manifestPath)!
        const ownership = parseOwnershipManifest(manifestRead.bytes.toString('utf8'), {
            root: identity.root, configPath: identity.configPath,
            cockpitId: publicationCockpitId({ name: config.cockpit.name }),
        })
        if (ownership.kind !== 'complete' || ownership.manifest.source.sha256 !== identity.configSha256) return unavailable('Installed guard publication is stale or unauthenticated.')
        const producer = ownership.manifest.producer
        if (producer.package !== installedPackageMetadata.name
            || producer.version !== installedPackageMetadata.version
            || producer.sourceRevision !== installedPackageMetadata.cockpitSourceRevision) return changed(`the installed cockpit version changed (the guards were generated by ${producer.package} ${producer.version}, ${installedPackageMetadata.name} ${installedPackageMetadata.version} is installed)`)
        const published = new Map<string, string>()
        for (const path of ['.cockpit/guards/bash-guard.sh', registration]) {
            const entry = ownership.manifest.entries.find(entry => entry.path === path)
            const actual = publication.get(path)!
            if (!entry || entry.kind !== 'file' || entry.sha256 !== actual.sha256) return unavailable('Installed guard registration or launcher bytes drifted.')
            published.set(path, actual.sha256)
        }
        const git = await adapters.resolveGit()
        if (git.state !== 'available') return unavailable('Guard checkout observation requires an authenticated Git executable.')
        const checkout = await adapters.observeCheckout({ source: loaded.result.source, cockpitName: config.cockpit.name,
            observedAt: new Date().toISOString(), env: {}, gitExecutable: git.value })
        const parsed = parseGuardInput(data.payload)
        if (parsed.status !== 'parsed') return unavailable(parsed.reason)
        if (parsed.cwd !== data.cwd) return unavailable('Guard request cwd does not match its invocation authority.')
        const prepared = await prepareGuardEvaluationPolicy({ configuration: loaded.result, checkout }, checkoutsPending.then(unwrap))
        if (prepared.kind !== 'complete') return unsynced
            ? unsyncedHold(identity, `, but the guard cannot build its policy from it (${prepared.diagnostics[0]?.message ?? 'no reason given'})`)
            : unavailable('Guard policy authority could not be authenticated.')
        // The inspector answers synchronously, so what only Git can say is asked first: which protected
        // paths a default ripgrep search reads, and which a repository's index holds for a Git command
        // that prints committed content. A request not asked here gets the walk, or no answer.
        const policy = prepared.result.policy
        const instancePaths = policy.instances.map(item => item.path)
        const present = (path: string) => { try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
        const allowed = (path: string) => policy.allowedRoots.some(root => confinedPath(root, path))
        // Each entry starts as the answer for Git not answering and is replaced by Git's.
        const unignored = new Map<string, readonly string[] | null | undefined>()
        const tracked = new Map<string, readonly string[] | null>()
        const queries: Array<() => Promise<void>> = []
        for (const invocation of parsed.invocations) {
            const access = classifyReadOnlyInvocation(invocation, { ripgrepConfigActive: data.ripgrepConfigActive === true })
            if (access?.trackedContent && allowed(access.cwd) && !tracked.has(access.cwd)) {
                tracked.set(access.cwd, null)
                queries.push(async () => { tracked.set(access.cwd, await guardTrackedSensitivePaths(access.cwd, instancePaths, git.value, adapters.execute ?? executeProbe)) })
            }
            for (const tree of access?.skipsIgnored ? access.trees : []) {
                const path = resolve(access!.cwd, tree)
                if (!allowed(path) || unignored.has(path) || !present(path)) continue
                unignored.set(path, undefined)
                queries.push(async () => { unignored.set(path, await guardUnignoredSensitivePaths(path, instancePaths, git.value, adapters.execute ?? executeProbe)) })
            }
        }
        // A query starts up to four Git processes, so a command naming many trees is asked about a few
        // at a time, and a failed one stops the rest from starting.
        const worker = async () => {
            for (let query = queries.shift(); query; query = queries.shift()) await query().catch((error: unknown) => { queries.length = 0; throw error })
        }
        await Promise.all([worker(), worker(), worker(), worker()])
        const walks = new Map<string, readonly string[] | null>()
        const searched = (path: string, unignoredOnly: boolean): readonly string[] | null => {
            const listed = unignoredOnly ? unignored.get(path) : undefined
            if (listed !== undefined) return listed
            let walked = walks.get(path)
            if (walked === undefined) walks.set(path, walked = guardSensitivePathsBelow(path))
            // The walk names environment and secrets names; an ignore-aware search also needs the instances it reads.
            if (!unignoredOnly || walked === null) return walked
            const found = [...new Set([...walked, ...instancePaths.filter(item => confinedPath(path, item) && present(item))])].sort()
            return found.length > GUARD_LOCATION_LIMITS.sensitivePaths ? null : found
        }
        const inspected = new Map<string, Stats>()
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
                        // A missing or non-directory component fails the system's lookup before `..` applies.
                        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
                    }
                    cursor = dirname(cursor)
                } else if (component && component !== '.') cursor = join(cursor, component)
            }
            return false
        }
        const inspect: import('../../guards/evaluator.js').PathInspection = request => {
            const path = resolve(request.cwd, request.path)
            const root = prepared.result.policy.allowedRoots.filter(root => confinedPath(root, path)).sort((a, b) => b.length - a.length)[0]
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
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { exists = false; break }
                    throw error
                }
                if (status.isSymbolicLink()) return { status: 'resolved', path, symlink: true }
                inspected.set(cursor, status)
                chain.push(guardIdentity(status))
            }
            const search = request.operation === 'search' || request.operation === 'unignored-search'
            return { status: 'resolved', path, symlink: false, identity: exists ? chain.at(-1)! : null, ancestors: exists ? chain.slice(0, -1) : chain,
                ...(search ? { sensitive: exists ? searched(path, request.operation === 'unignored-search') : [] } : {}),
                ...(request.operation === 'repository' ? { tracked: tracked.get(path) ?? null } : {}) }
        }
        const cockpitInvocations: GuardInvocationProfile[] = []
        const launcher = resolve(dirname(identity.module), '../bin/cockpit.mjs')
        const searchPath = data.searchPath ?? ''
        // Skills and fix hints print `npx --no cockpit …` and the onboarding procedure the installed
        // bin link; every spelling counts as the launcher only where it provably starts this installation.
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
        if (unsynced && !(parsed.tool === 'Bash' && parsed.invocations.length > 0 && parsed.invocations.every(invocation => launched.some(entry =>
            entry.session && entry.executable === invocation.executable && entry.cwd === invocation.cwd
            && isDeepStrictEqual(entry.argv, invocation.argv) && UNSYNCED_ADMITTED_COMMANDS.some(name => name === commandSpelling(entry.argv.slice(entry.prefix)).name))))) return unsyncedHold(identity, '')
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
                const admitted: Pick<GuardInvocationProfile, 'reads'> | undefined = session && ordinarySessionCommand(args, cwd, configured) ? {}
                    : resolveOrdinaryInvocation({ executable: launcher, cwd, argv: args }, authority, path => {
                        const fact = inspect({ path, cwd, operation: 'write' })
                        return !!fact && typeof fact === 'object' && 'status' in fact && fact.status === 'resolved'
                            && 'symlink' in fact && fact.symlink === false
                    })
                // The evaluator matches the invocation as the agent spelled it, and checks what it reads.
                if (admitted) cockpitInvocations.push({ executable, cwd, argv, ...(admitted.reads ? { reads: admitted.reads } : {}) })
            }
        }
        if (cockpitInvocations.length + prepared.result.policy.projectCommands.length > GUARD_INPUT_LIMITS.invocations) return unavailable('Guard candidates exceed the invocation bound.')
        // The policy pin needs the text an edit applies to, which must be the text the policy was built from.
        const configRead = publication.get(configName)!
        if (configRead.sha256 !== configSha256) return unavailable('Guard configuration changed during evaluation.')
        const configStatus = lstatSync(identity.configPath)
        // A hard link or another spelling of the configuration is the configuration.
        const isConfig = (path: string) => {
            if (foldGuardSpelling(path) === foldGuardSpelling(identity.configPath)) return true
            const status = lstatIfPresentSync(path)
            return status !== undefined && status.dev === configStatus.dev && status.ino === configStatus.ino
        }
        const pinned = pinnedPolicyDenial(parsed, configRead.bytes.toString('utf8'), isConfig)
        if (pinned) return { decision: pinned, diagnostics: [{ severity: 'error', code: 'GUARD_REFUSED', message: pinned.reason, target: 'guard' }] }
        const decision = evaluateGuard(parsed, { ...prepared.result.policy, cockpitInvocations,
            cockpitLaunchers: launched.map(({ executable, cwd, argv, prefix }) => ({ executable, cwd, argv: argv.slice(0, prefix) })),
            searchDirectories: guardSearchDirectories(searchPath, prepared.result.policy.allowedRoots),
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
        const currentPublication = await readPublication()
        for (const [path, hash] of [[manifestPath, manifestRead.sha256], [GUARD_LOCAL_PATHS.identity, publication.get(GUARD_LOCAL_PATHS.identity)!.sha256], ...published] as const) {
            if (currentPublication.get(path)!.sha256 !== hash) return unavailable('Guard publication changed during evaluation.')
        }
        if ((await read(dirname(identity.module), basename(identity.module), 16_777_216)).sha256 !== identity.moduleSha256) return unavailable('Guard handler changed during evaluation.')
        if (launcherSha256 && (await read(dirname(launcher), basename(launcher), 65_536)).sha256 !== launcherSha256) return unavailable('Guard ordinary command executable changed during evaluation.')
        return { decision, diagnostics: decision.decision === 'allow' ? [] : [{ severity: 'error', code: 'GUARD_REFUSED', message: decision.reason, target: 'guard' }] }
    } catch (error) {
        return unavailable(`Guard authority could not be read or revalidated: ${errorCause(error)}`)
    }
}

// The guard runs against the configuration sync generated it from, or one that does not widen it and
// admits only sync and check, so the policy read here grants nothing the last sync did not.
function ordinaryGrants(config: CockpitConfig): readonly OrdinaryGrant[] {
    const policy = effectivePolicy(config)
    return [...config.browser && browserPreapprovalRequested(config.browser) ? ['browser-preapproval' as const] : [],
        ...policy.autonomy.sync === 'agent' ? ['autonomy-sync' as const] : [], ...policy.autonomy.reset === 'agent' ? ['autonomy-reset' as const] : []]
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
    if (observed?.state !== 'available') return guardPolicyRefusal('guard policy checkout observation is unavailable')
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
            const protect = (root: string, path: string, leaf: 'file' | 'directory', label: string) => {
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
                    if (status.isSymbolicLink() || (index < segments.length - 1 || leaf === 'directory' ? !status.isDirectory() : !status.isFile())) {
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
            for (const { path, type } of GUARD_ROOT_PROTECTIONS) protect(canonicalRoot, join(canonicalRoot, path), type, 'guard control or secrets')
            // The configuration's own identity lets the evaluator recognise its deletion under any spelling.
            const configPath = loaded.source.path
            protect(canonicalRoot, configPath, 'file', 'configuration')
            // This module runs from dist/environment, so two levels up is the running cockpit package.
            const executionDirectories = guardInstalledDirectories(resolve(fileURLToPath(new URL('../../..', import.meta.url))), canonicalRoot)
                .filter(path => [...allowedRoots].some(root => confinedPath(root, path)))
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
                ripgrepConfigActive: false,
                executionDirectories, searchDirectories: [], searchPathRelativeEntry: null,
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
            const policies = guardConfig.environment.install_policies
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
