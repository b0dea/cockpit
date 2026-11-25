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
import { GUARD_EXECUTABLE_SEARCH_PATH, resolveExecutable } from '../executable.js'
import { CockpitConfig } from '../../schema.js'
import { instructionFrontmatterAsk } from '../../guards/instruction-frontmatter.js'
import { readBoundedFile } from '../../bounded-read.js'
import { policyChange } from '../../guards/policy-change.js'
import { relatedCheckoutHoldsRoot, relatedCheckoutPath } from '../../guards/related-checkouts.js'
import {
    evaluateGuard,
    approvedReadOnlyInvocation,
    cockpitLaunch,
    stashedBefore,
    cockpitShaped,
    innerCommand,
    gitInvocation,
    gitStagingPathspecs,
    GIT_GLOB,
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
    type GitTreeTarget,
    guardExtraction,
} from '../../guards/evaluator.js'
import { agentMayRun, commandConfiguration, commandSpelling, type OrdinaryGrant } from '../../command-table.js'
import { GUARD_INPUT_LIMITS, leavesCdpathAlone, parseGuardInput, type ParsedInvocation } from '../../guards/invocation-parser.js'
import { readAnchoredFile, readAnchoredBatches, nodeAuthority } from '../../generated-environment/transaction.js'
import { parseOwnershipManifest } from '../../surfaces/ownership.js'
import { installedPackageMetadata } from '../../package-metadata.js'
import { GUARD_LOCAL_PATHS, guardHandlerSuperseded, parseGuardLocalIdentity, type GuardHandlerIdentity } from '../../guards/local-identity.js'
import { checkoutOf, mainCheckoutGuardIdentity, worktreeBindArgv } from '../../guards/linked-worktree.js'
import { inspectGuardRecord } from '../../guards/guard-record.js'
import {
    guardInstalledDirectories,
    guardSearchDirectories,
    guardSecretFiles,
    guardSensitivePathsBelow,
    guardCarriedPathsBelow,
    guardBranchFacts,
    guardPackageManifest,
    guardPatchTargets,
    guardRemoteCredentials,
    guardWorktreeChanges,
    guardArchiveEntries,
    guardCommittedSensitivePaths,
    guardTrackedSensitivePaths,
    guardUnignoredSensitivePaths,
    guardStagedPaths,
} from '../../guards/protected-locations.js'
import { classifyReadOnlyInvocation } from '../../guards/read-only.js'
import { fileFingerprint, recordVerifiedDigest } from '../../environment-exec/verified-digest.js'
import { GUARD_HELD_CALLS, GUARD_UNHELD_CALLS, isGuardSurfaceTarget, type GuardSurfaceTarget } from '../../surfaces/harness-registry.js'
import { formatShellCommand, oneCommandLine, type FixContext } from '../../fix-catalogue.js'
import { guardRecovery, installedSyncCommand } from '../../surfaces/guard-recovery.js'
import { redactSensitiveMessage } from '../sensitive.js'
import { observeInstallPolicyLockfiles, withInstallPolicyProjection } from '../install-policy-observation.js'
import { resolveInstallPolicies, renderGuardProjectCommand } from '../install-policy.js'
import { checkoutId as deriveCheckoutId, publicationCockpitId } from '../identity.js'
import {
    consumeSetupCheckoutProjection,
    observeSetupCheckout,
    withSetupCheckoutProjection,
    type SetupCheckoutObservation,
} from '../setup-observation.js'
import { browserPreapprovalRequested, loadCockpitConfig, consumeLoadedConfigProjection, type LoadedConfigProjection } from '../../config/load.js'
import { deriveRegistry } from '../../registry-derivation.js'
import { confinedPath, lifecycleRefusal, ownDataValues, sameSource } from './shared.js'
import { splitRepositoryPath } from '../../repository-path.js'
import { GUARD_AGENT_VARIABLES, guardAgentAreas, type GuardAgentEnvironment, type GuardAgentSession } from '../../guards/agent-workspaces.js'
import { readSiblingCheckouts, servedSiblings, type ServedSibling, type SiblingCheckoutRecordRead } from '../sibling-checkouts.js'

export interface GuardEvaluationApplicationInput {
    readonly identity: unknown
    /** The checkout the invoked guard script resolved from its own location. */
    readonly guardRoot: string
    readonly payload: unknown
    readonly harness: GuardSurfaceTarget
    readonly cwd: string
    readonly askIsDeny?: boolean
    /** The call is made in a linked worktree nobody has synced, which this checkout's guard judges for it. */
    readonly unsyncedWorktree?: boolean
    /** Another checkout's guard handed this call over; it is judged here and never handed on. */
    readonly delegated?: boolean
    readonly ripgrepConfigActive?: boolean
    /** The harness's command search path, whose directories inside the allowed roots the guard protects. */
    readonly searchPath?: string
    /** HOME and XDG_CONFIG_HOME of the harness, where Git reads the person's global configuration. */
    readonly home?: string
    /** CDPATH of the hook's process, empty when unset; only Claude Code's is the one its shell has. */
    readonly cdpath?: string
    readonly xdgConfigHome?: string
    /** What the hook payload says about the agent's session, which locates its own files. */
    readonly agentSession?: GuardAgentSession
    /** The harness's variables that move the agent tool's own files. */
    readonly agentEnvironment?: GuardAgentEnvironment
}

interface GuardEvaluationApplicationAdapters {
    readonly loadConfig: typeof loadCockpitConfig
    readonly observeCheckout: typeof observeSetupCheckout
    readonly resolveGit: () => Promise<import('../executable.js').ExecutableResolution>
    readonly execute?: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
}

interface GuardEvaluationApplicationResult {
    readonly decision: GuardDecision
    readonly diagnostics: readonly import('../contract.js').Diagnostic[]
    readonly fixContext?: FixContext
    /** The checkout whose own hook check judges this call; the decision beside it refuses for a caller that cannot run it. */
    readonly delegate?: string
}

// Every refusal below holds all of the agent's guarded calls, `git restore` included, so each says what
// failed, why that blocks everything, and the human action that clears it. Regeneration is a human
// step on purpose: guard policy comes from the configuration sync recorded, and an agent able to
// record its own edit could loosen its guard.
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
    const why = 'the guard trusts only the cockpit and configuration it was generated for'
    // A package manager that keeps each version at its own path, as pnpm does, leaves the bound handler in place after
    // an upgrade. It still authenticates and keeps judging calls, but its own version is not the installed one, so a
    // drift it meets is named by both copies, and sync is the fix. While nothing drifts, it runs on unheld.
    const superseded = guardHandlerSuperseded(identity.root, identity.module)
    if (superseded) return guardHeld(identity, superseded, why)
    if (order === undefined || order > 0) {
        const what = generated === undefined || generated === installed
            ? 'the installed cockpit version changed (its handler bytes differ) since the guards were generated'
            : `the installed cockpit version changed since the guards were generated: ${installedPackageMetadata.name} ${installed} is installed, newer than ${generated}, which generated them`
        // A newer cockpit installed over generated files from an older one is what a branch the upgrade
        // has not reached looks like, so that branch is named beside the sync.
        return generated === undefined || generated === installed ? guardHeld(identity, what, why)
            : guardHeld(identity, what, why, `${guardRecovery(identity.root, identity.configPath, recoveryState(identity))} Or check out the branch that upgraded cockpit, whose generated files the installed version made.`)
    }
    const lockfile = LOCKFILE_INSTALLS.find(([file]) => recoveryFile(join(identity.root, file), constants.R_OK))
    const install = lockfile ? `with \`${oneCommandLine([lockfile[1]], identity.root)}\`` : `with the repository's documented dependency install in ${formatShellCommand([identity.root])}`
    return guardHeld(identity,
        `the installed cockpit is older than the one that generated the guards: ${installedPackageMetadata.name} ${installed} is installed, and ${generated} generated them, as after switching to a branch or checkout whose dependencies were installed earlier`,
        why, `Fix: install the dependencies the lockfile pins, ${install}, outside the agent; sync is not the fix, since it would regenerate the guards with the older version. If the older version is intended, a human runs \`${installedSyncCommand(identity.root, identity.configPath)}\` in a terminal instead.`)
}

// A new linked worktree carries the committed cockpit files but not the machine-local identity sync binds, so every
// worktree waited for a person to sync there, though that sync wrote nothing but the identity. Its bind runs with this
// checkout's own Node and cockpit, named by absolute path, and checks for itself that it grants nothing this checkout's
// sync did not, so the agent runs it. Nothing from the worktree runs before its guard is bound: an install there runs
// the worktree's own package scripts and settings, and its node_modules can hold any launcher.
type WorktreeBootstrap = Readonly<{
    root: string
    /** The one command that binds the worktree's guard, as argv. */
    bind: readonly string[]
    /** Why the bind is not admitted, when it is not. */
    refused?: string
}>

/**
 * What an agent may run to bind the guard of the linked worktree holding `cwd`, when its main checkout is `identity`'s.
 * The check hands this checkout a worktree whose own guard cannot run: no identity, or one naming a runtime that is gone.
 */
function worktreeBootstrap(cwd: string, identity: GuardHandlerIdentity): WorktreeBootstrap | undefined {
    const checkout = checkoutOf(cwd)
    return checkout && checkout.top !== checkout.main && checkout.main === identity.root ? worktreeBind(checkout.top, identity) : undefined
}

/**
 * The top of another checkout of the repository the cockpit at `root` is checked out from, when it holds `cwd` and `cwd`
 * lies outside every root this guard manages: a linked worktree of it, or its main checkout when `root` is a linked
 * worktree. Git's own files must name each linked worktree back, as the hook's check requires before it runs a guard.
 */
function otherCheckoutOfRepository(cwd: string, root: string, allowedRoots: readonly string[]): string | undefined {
    if (allowedRoots.some(allowed => confinedPath(allowed, cwd))) return undefined
    const own = checkoutOf(root)
    if (own?.top !== root) return undefined
    const other = checkoutOf(cwd)
    return other && other.top !== root && other.main === own.main ? other.top : undefined
}

/**
 * The bind of a worktree's own guard when its binding went stale: a rebase onto a main checkout that upgraded cockpit,
 * or an install that replaced the cockpit it ran. Only a linked worktree whose main checkout has its own identity has
 * one; the main checkout's upgrade is a person's sync, since binding new cockpit code is that approval.
 */
function worktreeRebind(identity: GuardHandlerIdentity): WorktreeBootstrap | undefined {
    const mainIdentity = mainCheckoutGuardIdentity(identity.root)
    return mainIdentity ? worktreeBind(identity.root, mainIdentity) : undefined
}

/** The bind of the worktree at `root` through the Node and cockpit package the main checkout's `identity` names. */
function worktreeBind(root: string, identity: GuardHandlerIdentity): WorktreeBootstrap {
    const bind = worktreeBindArgv(root, identity)
    const packageRoot = dirname(dirname(identity.module))
    const launcher = bind[1]!
    let refused: string | undefined
    try {
        if (!confinedPath(packageRoot, realpathSync(launcher))) refused = `${launcher} leads out of the cockpit package at ${packageRoot}`
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES')) throw error
        refused = `${launcher} could not be resolved (${forwardedReason(errorCause(error))})`
    }
    return { root, bind, ...refused === undefined ? {} : { refused } }
}

/** Whether the call is exactly the bind, alone and from the worktree root. */
function bootstrapAdmits(parsed: Extract<ReturnType<typeof parseGuardInput>, { status: 'parsed' }>, bootstrap: WorktreeBootstrap): boolean {
    const call = parsed.invocations[0]
    if (bootstrap.refused !== undefined || parsed.tool !== 'Bash' || parsed.background || parsed.unreadable || parsed.loop || parsed.cdByName !== undefined
        || parsed.invocations.length !== 1 || !call || call.cwd !== bootstrap.root || call.executable === null || call.wrapped || call.dynamic || call.piped
        || call.background || call.expandsStatus || call.redirects.length || call.words.length !== call.argv.length + 1 || call.words.some(word => word.dynamic)) return false
    const spelled = [call.executable, ...call.argv]
    return spelled.length === bootstrap.bind.length && spelled.every((word, index) => word === bootstrap.bind[index])
}

// A guard message reaches the agent and the harness's log: text it forwards from a failure stays one
// bounded line with credential-shaped values removed.
function forwardedReason(reason: string): string {
    return redactSensitiveMessage(reason.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/(\w+:\/\/)[^/@\s]+@/g, '$1[redacted]@').slice(0, 512)) ?? 'the reason was withheld because it could not be redacted'
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
        const data = ownDataValues(snapshotJson(input), ['cwd', 'guardRoot', 'harness', 'identity', 'payload'], ['askIsDeny', 'unsyncedWorktree', 'delegated', 'ripgrepConfigActive', 'searchPath', 'home', 'cdpath', 'xdgConfigHome', 'agentSession', 'agentEnvironment'])
        const directory = (value: unknown) => value === undefined || typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)
            && Buffer.byteLength(value) <= GUARD_INPUT_LIMITS.pathBytes
        if (!data || !directory(data.home) || !directory(data.xdgConfigHome)
            || data.searchPath !== undefined && (typeof data.searchPath !== 'string' || /[\x00-\x1f\x7f]/.test(data.searchPath) || Buffer.byteLength(data.searchPath) > GUARD_INPUT_LIMITS.inputBytes)
            || data.cdpath !== undefined && typeof data.cdpath !== 'string'
            || data.askIsDeny !== undefined && typeof data.askIsDeny !== 'boolean'
            || data.unsyncedWorktree !== undefined && typeof data.unsyncedWorktree !== 'boolean'
            || data.delegated !== undefined && typeof data.delegated !== 'boolean'
            || data.ripgrepConfigActive !== undefined && typeof data.ripgrepConfigActive !== 'boolean'
            || !isGuardSurfaceTarget(data.harness)) return unavailable('Guard request is malformed.')
        const agentSession = data.agentSession === undefined ? {} : ownDataValues(data.agentSession, [], ['transcriptPath', 'sessionId', 'scratchpadDir', 'agentType'])
        const agentEnvironment = data.agentEnvironment === undefined ? {} : ownDataValues(data.agentEnvironment, [], GUARD_AGENT_VARIABLES)
        if (!agentSession || !agentEnvironment || ![...Object.values(agentSession), ...Object.values(agentEnvironment)]
            .every(value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= GUARD_INPUT_LIMITS.pathBytes)) return unavailable('Guard request is malformed.')
        const harness = data.harness
        // Claude Code runs each Bash command in a shell that first sources its shell snapshot, and the snapshot exports
        // only PATH and sets neither CDPATH nor zsh's cdpath (measured 2026-11-25), so that shell's CDPATH is the one Claude
        // Code's own process has, which its hooks inherit. When the hook's is empty, `cd name` resolves from the working
        // directory alone, a dot-leading name included. The hook passes no CDPATH when a start-up file the shell reads,
        // .zshenv, BASH_ENV's or CLAUDE_ENV_FILE's, mentions cdpath or cannot be read; a file sourced from those stays
        // unseen. Codex and OpenCode shells may source a profile, so a bare name there, as under a non-empty CDPATH, stays
        // one a CDPATH entry could send elsewhere.
        const knownEmpty = harness === 'claudecode' && data.cdpath === ''
        // Shell text that runs in this shell can set CDPATH unseen: a sourced file, as `. ./x.sh && cd .aws` after a write
        // of x.sh, `eval`, zsh's `emulate -c`, a `mapfile` callback or a loaded builtin. So the empty CDPATH holds only for
        // a call whose every command, nested ones included, is an external program or a builtin that evaluates nothing;
        // any other call is read with CDPATH unknown, from its first command.
        const parseCall = (payload: unknown) => {
            const parsed = parseGuardInput(payload, { home: homedir(), ...knownEmpty ? { cdpath: '' } : {} })
            return knownEmpty && parsed.status === 'parsed' && (parsed.unreadable || !parsed.invocations.every(leavesCdpathAlone))
                ? parseGuardInput(payload, { home: homedir() }) : parsed
        }
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
        // A hold over a stale binding in a linked worktree admits exactly the bind through its main checkout's cockpit, and
        // names it; every other hold stays a person's.
        const rebind = worktreeRebind(identity)
        const early = rebind && parseCall(data.payload)
        const stale = (held: GuardEvaluationApplicationResult): GuardEvaluationApplicationResult => {
            if (!rebind) return held
            if (early?.status === 'parsed' && early.cwd === data.cwd && bootstrapAdmits(early, rebind)) {
                return { decision: { decision: 'allow', reason: `Binds the guard of the linked worktree ${rebind.root} to the cockpit and configuration its main checkout synced.` }, diagnostics: [] }
            }
            return rebind.refused ? held : unavailable(`${held.decision.reason} Or, since this is a linked worktree, run alone from ${rebind.root} the command that binds its guard `
                + `to its main checkout's cockpit and configuration: \`${formatShellCommand(rebind.bind)}\`.`)
        }
        const changed = (what: string) => unavailable(guardHeld(identity, `${what} since the guards were generated`,
            'the guard trusts only the cockpit and configuration it was generated for'))
        if (realpathSync(fileURLToPath(new URL('../../../dist/cli.js', import.meta.url))) !== identity.module) return stale(changed('a different cockpit installation is running'))
        const roots = new Map<string, Stats>()
        const rootStatus = lstatSync(identity.root)
        if (!rootStatus.isDirectory() || String(rootStatus.ino) !== identity.rootInode || realpathSync(identity.root) !== identity.root) {
            return changed(`the cockpit checkout ${identity.root} was moved or replaced`)
        }
        roots.set(identity.root, rootStatus)
        // Whichever Node the hook ran: the record pins its path, not the binary behind it. Re-hashing a
        // 100 MB Node binary dominated each call, so the Node file sync hashed, unchanged by path, inode,
        // size, mode and timestamps, keeps the digest sync recorded.
        const running = realpathSync(process.execPath)
        if (fileFingerprint(running, lstatSync(running)) === identity.nodeFingerprint) recordVerifiedDigest(identity.nodeFingerprint, identity.nodeSha256)
        const node = await nodeAuthority()
        if (!node) return unavailable(`The Node executable ${process.execPath} could not be read.`)
        const read = async (root: string, path: string, maxBytes: number) => {
            const result = await readAnchoredFile(root, path, maxBytes, node, { execute: adapters.execute ?? executeProbe })
            if (result.kind !== 'complete') throw new RefusalError('Guard authority file is missing, changed, oversized or crosses a symlink boundary.')
            return result
        }
        const manifestPath = '.cockpit/generated-environment-ownership.json'
        const registration = { claudecode: '.claude/settings.json', codexcli: '.codex/hooks.json', opencode: '.opencode/plugin/cockpit-guards.js' }[harness]
        const publicationRequests = [manifestPath, '.cockpit/guards/bash-guard.sh', registration, GUARD_LOCAL_PATHS.identity].map(path => ({
            path, action: 'read-file' as const, maxBytes: path === manifestPath ? 1_048_576 : 65_536,
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
            return stale(unavailable(versionDrift(identity, typeof producer === 'string' ? producer : undefined)))
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
            if (ownership.kind !== 'complete' || ownership.manifest.source.sha256 !== identity.configSha256) {
                // A branch the upgrade has not reached carries generated files from the earlier cockpit
                // and cockpit.toml. Held only as stale, nothing named the versions or the fix; the
                // producer is read here only to word that, and authorizes nothing.
                const manifest = tryParseJson(manifestRead.bytes.toString('utf8'))
                const producer = manifest && typeof manifest === 'object' ? (manifest as { producer?: { package?: unknown; version?: unknown } }).producer : undefined
                if (producer?.package === installedPackageMetadata.name && typeof producer.version === 'string' && producer.version !== installedPackageMetadata.version) {
                    return { held: stale(unavailable(versionDrift(identity, producer.version))) }
                }
                const generatedElsewhere = ownership.kind === 'complete'
                const held = unavailable(`Installed guard publication is stale or unauthenticated: ${!generatedElsewhere
                    ? 'its ownership manifest does not parse or does not authenticate'
                    : 'it was generated from a different cockpit.toml than the one the guard identity records'}.`)
                return { held: generatedElsewhere ? stale(held) : held }
            }
            const producer = ownership.manifest.producer
            if (producer.package !== installedPackageMetadata.name
                || producer.version !== installedPackageMetadata.version
                || producer.sourceRevision !== installedPackageMetadata.cockpitSourceRevision) {
                if (producer.package === installedPackageMetadata.name && producer.version !== installedPackageMetadata.version) return { held: stale(unavailable(versionDrift(identity, producer.version))) }
                return { held: stale(changed(`the installed cockpit version changed (the guards were generated by ${producer.package} ${producer.version}, ${installedPackageMetadata.name} ${installedPackageMetadata.version} is installed)`)) }
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
        // The guard's authority is the configuration last synced, which sync recorded beside the guard's
        // identity. cockpit.toml is judged as written only while it loads and widens nothing that record
        // grants; otherwise calls are judged under the record, so no state of the file holds the agent,
        // which repairs it with any tool. Holding instead left the agent stranded by every spelling that
        // could delete, link or empty the file, until a person repaired it.
        const recordPath = join(identity.root, GUARD_LOCAL_PATHS.generatedConfig)
        const lastSynced = async () => {
            const recorded = await adapters.loadConfig(recordPath)
            return recorded.kind === 'complete' && recorded.result.source.path === recordPath && recorded.result.source.sha256 === identity.configSha256
                ? recorded.result : undefined
        }
        const personSyncs = `a person runs \`${oneCommandLine(['npx --no cockpit approve'], identity.root)}\` in a terminal outside the agent, and confirms it`
        // Plain sync refuses a configuration it cannot compare with the last one, so the fix names the sync
        // that asks a person; one with no cockpit.toml to read keeps the recovery for a missing file.
        const unrecorded = (why: string) => unavailable(guardHeld(identity, `${why}, and the configuration last synced is missing from ${GUARD_LOCAL_PATHS.generatedConfig} or does not load there`,
            'guard policy comes from that record', recoveryState(identity).config ? `Fix: ${personSyncs}.` : undefined))
        const underRecord = (why: string, until: string) => ` ${why}; calls are judged under the configuration last synced until ${until}.`
        const loaded = unwrap(await configPending)
        let declared: LoadedConfigProjection
        if (loaded.kind !== 'complete' || loaded.result.source.path !== identity.configPath) {
            const why = `${identity.configPath} ${loaded.kind === 'complete' ? 'is a link' : `does not load (${forwardedReason(loaded.diagnostics[0]?.message ?? 'no reason given')})`}`
            const recorded = await lastSynced()
            if (!recorded) return unrecorded(why)
            declared = recorded
            notice = underRecord(why, 'the file loads again, which the agent may repair with any tool')
        } else if (loaded.result.source.sha256 === identity.configSha256) declared = loaded.result
        else {
            // An edit since sync that does not widen the configuration last synced grants nothing that sync
            // did not, so calls are judged under it at once.
            const recorded = await lastSynced()
            if (!recorded) return unrecorded(`${identity.configPath} changed since the guards were generated`)
            const change = policyChange(recorded.config, loaded.result.config, { root: realpathSync(identity.root), home: homedir() })
            declared = change.kind === 'widening' ? recorded : loaded.result
            if (change.kind === 'widening') notice = underRecord(`${identity.configPath} has an unapproved edit that widens what agents may do (${change.fields.join(', ')})`, personSyncs)
        }
        const authenticated = await authenticatePublication(publicationPending, declared.config.cockpit.name)
        if (authenticated.held) return authenticated.held
        const { publication, manifestRead, published } = authenticated
        const git = await adapters.resolveGit()
        if (git.state !== 'available') return unavailable('Guard checkout observation requires an authenticated Git executable.')
        const build = async (from: LoadedConfigProjection) => {
            const observed = await adapters.observeCheckout({ source: from.source, cockpitName: from.config.cockpit.name,
                observedAt: new Date().toISOString(), env: {}, gitExecutable: git.value })
            return { checkout: observed, config: from.config, source: { path: from.source.path, sha256: from.source.sha256 },
                prepared: await prepareGuardEvaluationPolicy({ configuration: from, checkout: observed, configPath: identity.configPath }, checkoutsPending.then(unwrap)) }
        }
        let built = await build(declared)
        // An edit that widens nothing but whose policy cannot be built, such as a sibling that escapes its
        // root, leaves the configuration last synced to judge by, as an edit that does not load does.
        if (built.prepared.kind !== 'complete' && declared === loaded.result && loaded.result.source.sha256 !== identity.configSha256) {
            // Only a record that builds is a way out: a failure it shares, such as an unreadable checkout, has
            // nothing to do with the edit and is reported as it is.
            const recorded = await lastSynced()
            const fallback = recorded && await build(recorded)
            if (fallback && fallback.prepared.kind === 'complete') {
                notice = underRecord(`${identity.configPath} changed since the guards were generated, but the guard cannot build its policy from it (${forwardedReason(built.prepared.diagnostics[0]?.message ?? 'no reason given')})`, 'it is corrected or reverted')
                built = fallback
            }
        }
        const { checkout, config, prepared } = built
        // What the policy is built from, checked unchanged once the call is judged.
        const policySource = built.source
        const widening = notice !== ''
        // A word the guard cannot expand is marked, not refused: the evaluator refuses it only where it
        // decides what is read, written or pushed.
        const parsed = parseCall(data.payload)
        if (parsed.status !== 'parsed') return unavailable(parsed.reason)
        // A shell left in a directory that was removed, such as a linked worktree kept inside the checkout, reaches nothing
        // by a physical relative path, and the agent tool then starts the guard in the session's own directory. Refused
        // for that, every call failed, the cd back out and absolute paths included. Such a directory inside a managed
        // root is judged as reported: the shell resolves `cd ..` and `cd name` from it by its spelling, as the guard does.
        const removedCwd = parsed.cwd !== data.cwd && prepared.kind === 'complete' && lstatIfPresentSync(parsed.cwd) === undefined
            && prepared.result.policy.allowedRoots.some(root => confinedPath(root, parsed.cwd))
        // The harness reports the agent's working directory and starts the guard in a canonical one; they differ when
        // the agent's shell changed directory through a link or under another spelling.
        if (parsed.cwd !== data.cwd && !removedCwd) return unavailable(`The call reports the working directory ${JSON.stringify(parsed.cwd)}, but the guard runs in ${JSON.stringify(data.cwd)}: `
            + `paths are judged from one directory only. Change to ${JSON.stringify(data.cwd)} itself, then run the command.`)
        if (prepared.kind !== 'complete') {
            return unavailable(checkout.state === 'available'
                ? `Guard policy authority could not be authenticated: ${prepared.diagnostics[0]?.message ?? 'no reason given'}`
                : prepared.diagnostics[0]?.message ?? 'Guard checkout observation failed without a reason.')
        }
        // A session that starts in one checkout and works in another checkout of the same repository, such as a worktree
        // kept beside it, had every call there refused as outside this guard's roots. Such a call is handed whole to the
        // hook's check, started from that checkout, which then picks and authenticates its guard exactly as for a session
        // started there, and that answer stands unchanged. This grants no more than starting the session there: only a
        // call this guard would refuse as outside its roots is handed over, only to a checkout whose Git files name this
        // repository back, the bound the check itself applies, and the guard that judges it is the one that protects that
        // checkout's own guard, records and settings. A handed-over call is never handed on, nor is one this checkout
        // judges for a worktree nobody has synced, so no chain of checkouts can pass a call along to a looser guard.
        const handedTo = data.unsyncedWorktree === true || data.delegated === true ? undefined
            : otherCheckoutOfRepository(parsed.cwd, identity.root, prepared.result.policy.allowedRoots)
        if (handedTo !== undefined) {
            return { ...unavailable(`${parsed.cwd} is in ${handedTo}, another checkout of this repository, whose own guard judges this call.`), delegate: handedTo }
        }
        // A call that only changes or prints the working directory: enough to leave a worktree nobody has synced.
        const leaves = parsed.tool === 'Bash' && !parsed.background && !parsed.unreadable
            && parsed.invocations.every(({ executable, argv, words, redirects }) => redirects.length === 0
                && (executable === null ? words.length === 1 && words[0]!.role === 'directory' : executable === 'pwd' && argv.length === 0))
        // Judged before this checkout's policy, which does not reach a worktree kept beside it, and before its own
        // pending widening or the ask for another cockpit's configuration: the bind applies only what this checkout's
        // sync applied, and refuses anything else itself.
        const bootstrap = data.unsyncedWorktree === true ? worktreeBootstrap(parsed.cwd, identity) : undefined
        if (bootstrap && leaves) return refused({ decision: 'allow', reason: 'Changes or prints the working directory only.' })
        if (bootstrap && bootstrapAdmits(parsed, bootstrap)) {
            return refused({ decision: 'allow', reason: `Binds the guard of the linked worktree ${bootstrap.root} to the cockpit and configuration ${identity.root} synced.` })
        }
        // The inspector answers synchronously, so what only Git can say is asked first: which protected
        // paths a default ripgrep search reads, and which a repository's index holds for a Git command
        // that prints committed content. A request not asked here gets the walk, or no answer.
        const policy = prepared.result.policy
        // The agent tool's own files, located from this call's payload and the harness's variables.
        const agentAreas = harness === 'claudecode' || harness === 'codexcli' || harness === 'opencode'
            ? guardAgentAreas(harness, agentSession as GuardAgentSession, { home: realpathSync(homedir()), uid: process.getuid?.() ?? -1, env: agentEnvironment as GuardAgentEnvironment }, policy.allowedRoots)
            : undefined
        const agentRoots = agentAreas ? [...agentAreas.agentHomes.map(home => home.path), ...agentAreas.agentWorkspaces.map(area => area.path), ...agentAreas.agentReadAreas] : []
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
        // What history ever held, asked only for a command that can print a commit: it walks every commit.
        const committed = new Map<string, readonly string[] | null>()
        // The commits each repository's history commands name, walked beside every ref.
        const walkedRevisions = new Map<string, Set<string>>()
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
        const treeKey = (cwd: string, target: GitTreeTarget) => `${cwd}\0${JSON.stringify([target.revision, target.from ?? null, target.paths ?? null, target.fallback ?? null, target.remote ?? null, target.optional ?? null, target.keepsLocal ?? null])}`
        for (const [at, invocation] of parsed.invocations.entries()) {
            const command = gitInvocation(invocation)
            const written = command && !command.uncertain && allowed(command.cwd) ? gitTreeTargets(command, stashedBefore(parsed.invocations, at, command.cwd)) : undefined
            for (const target of written && 'targets' in written ? written.targets : []) {
                const key = treeKey(command!.cwd, target)
                if (trees.has(key)) continue
                trees.set(key, null)
                queries.push(async () => { trees.set(key, await guardWorktreeChanges(command!.cwd, target, protectedPaths, git.value, adapters.execute ?? executeProbe, gitEnvironment)) })
            }
        }
        // What an extraction into the roots writes: its archive, inside the roots, is listed before the call is judged.
        const archives = new Map<string, Awaited<ReturnType<typeof guardArchiveEntries>>>()
        const archiveKey = (path: string, format: string) => `${path}\0${format}`
        for (const invocation of parsed.invocations) {
            const extracted = guardExtraction(invocation)
            if (!extracted || extracted === 'unmodelled') continue
            const path = resolve(invocation.cwd, extracted.archive)
            const key = archiveKey(path, extracted.format)
            if (!allowed(path) || archives.has(key)) continue
            archives.set(key, null)
            queries.push(async () => {
                const tool = await resolveExecutable(extracted.format === 'tar' ? 'tar' : 'unzip', { PATH: GUARD_EXECUTABLE_SEARCH_PATH })
                if (tool.state === 'available') archives.set(key, await guardArchiveEntries(path, extracted.format, tool.value, adapters.execute ?? executeProbe))
            })
        }
        // What a `git add` or `git commit` naming a glob or a directory stages: Git lists the changed and untracked paths it matches.
        const staged = new Map<string, readonly string[] | null | undefined>()
        const stagedKey = (cwd: string, path: string, literal: boolean) => `${cwd}\0${literal}\0${path}`
        for (const invocation of parsed.invocations) {
            const command = gitInvocation(invocation)
            const staging = command && !command.uncertain && allowed(command.cwd) ? gitStagingPathspecs(command, invocation) : undefined
            for (const pathspec of staging && !staging.force ? staging.pathspecs : []) {
                const path = pathspec.literal ?? pathspec.spelled
                const literal = pathspec.literal !== undefined
                const target = resolve(command!.cwd, path)
                const key = stagedKey(command!.cwd, path, literal)
                if (!allowed(target) || staged.has(key) || !(!literal && GIT_GLOB.test(path) || lstatIfPresentSync(target)?.isDirectory())) continue
                staged.set(key, undefined)
                queries.push(async () => { staged.set(key, await guardStagedPaths(command!.cwd, path, literal, git.value, adapters.execute ?? executeProbe)) })
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
            if (access?.trackedContent && (allowed(access.cwd) || nativeGit(access.cwd) && parsed.invocations.length === 1)) {
                if (!tracked.has(access.cwd)) {
                    tracked.set(access.cwd, null)
                    queries.push(async () => { tracked.set(access.cwd, await guardTrackedSensitivePaths(access.cwd, watchedPaths, git.value, adapters.execute ?? executeProbe)) })
                }
                if (access.trackedContent.history) {
                    const named = walkedRevisions.get(access.cwd) ?? new Set<string>()
                    for (const revision of access.trackedContent.revisions ?? []) named.add(revision)
                    walkedRevisions.set(access.cwd, named)
                }
            }
            for (const tree of access?.skipsIgnored ? access.trees : []) {
                const path = resolve(access!.cwd, tree)
                if (!allowed(path) || unignored.has(path) || !present(path) || realpathSync(path) !== path) continue
                unignored.set(path, undefined)
                queries.push(async () => { unignored.set(path, await guardUnignoredSensitivePaths(path, watchedPaths, git.value, adapters.execute ?? executeProbe)) })
            }
        }
        for (const [cwd, revisions] of walkedRevisions) {
            committed.set(cwd, null)
            queries.push(async () => { committed.set(cwd, await guardCommittedSensitivePaths(cwd, watchedPaths, git.value, adapters.execute ?? executeProbe, [...revisions].sort())) })
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
        // Every path the evaluator asked about outside the roots, kept only to word a refusal.
        const outside = new Set<string>()
        const inspect: import('../../guards/evaluator.js').PathInspection = request => {
            const path = resolve(request.cwd, request.path)
            if (!allowed(path)) outside.add(path)
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
                const facts = request.revision === undefined ? null : trees.get(treeKey(path, { ...request, revision: request.revision }))
                return facts ? { status: 'resolved', path, revision: request.revision, ...request.from === undefined ? {} : { from: request.from }, ...facts }
                    : { status: 'unavailable', path, symlink: false }
            }
            if (request.operation === 'archive') {
                const listed = request.format === undefined ? undefined : archives.get(archiveKey(path, request.format))
                return listed ? { status: 'resolved', path, ...listed } : { status: 'unavailable', path, symlink: false }
            }
            if (request.operation === 'external-write') {
                // The system resolves `link/..` from where the link leads, so such a spelling lands somewhere its
                // lexical path does not say: no landing is reported, and the write is refused.
                if (leavesLink(request.cwd, request.path)) return { status: 'unavailable', path, symlink: true }
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
                const landsAt = join(realpathSync(cursor), ...rest)
                // An existing file with another hard link is reported, since writing it writes every name it has.
                const target = rest.length ? undefined : lstatIfPresentSync(landsAt)
                return { status: 'resolved', path, landsAt, ...target?.isFile() ? { links: target.nlink } : {} }
            }
            if (request.operation === 'pathspec') {
                const matches = staged.get(stagedKey(request.cwd, request.path, request.literal === true))
                return matches ? { status: 'resolved', path, matches } : { status: 'unavailable', path, symlink: false }
            }
            if (request.operation === 'manifest') {
                const manifest = allowed(path) ? guardPackageManifest(path, allowed, request.workspace === true) : null
                return manifest ? { status: 'resolved', path, ...manifest } : { status: 'unavailable', path, symlink: false }
            }
            const managedRoot = policy.allowedRoots.filter(root => confinedPath(root, path)).sort((a, b) => b.length - a.length)[0]
            const reading = ['read', 'list', 'search', 'unignored-search'].includes(request.operation)
            // A related checkout is read as a root is: a named file, a listing or a search walked for secrets.
            const relatedRoot = !managedRoot && reading ? policy.relatedCheckouts?.find(root => confinedPath(root, path)) : undefined
            // The agent's own files are read from the area that holds them, through the spelling that leads there,
            // such as /tmp; the evaluator decides which of them may be read.
            const agentRoot = !managedRoot && !relatedRoot && reading ? agentRoots.filter(root => confinedPath(root, path)).sort((a, b) => b.length - a.length)[0] : undefined
            // A person's read path admits this read, or with native external reads the agent tool's own permission decided it.
            const declaredRead = !managedRoot && reading
                && (policy.externalReads === 'native' || (policy.readPaths ?? []).some(root => confinedPath(root, path)))
            const externalRead = reading && (approvedReads.has(path) || approvedRequirements.has(path)) || declaredRead
                || request.operation === 'cwd' && approvedDirectories.has(path) || request.operation === 'repository' && tracked.has(path)
            const root = managedRoot ?? relatedRoot ?? agentRoot ?? (externalRead ? '/' : undefined)
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
                        // The link is resolved, not the whole path: a name below it that does not exist, as a
                        // glob's pattern does not, is judged as missing where the link leads.
                        const leadsTo = realpathSync(cursor)
                        const target = join(leadsTo, relative(cursor, path))
                        const leads = allowed(target) ? lstatIfPresentSync(target) ?? 'missing' : undefined
                        if (leads === 'missing' || leads && (leads.isFile() || request.operation !== 'read' && leads.isDirectory())) {
                            readLinks.set(cursor, leadsTo)
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
                ...(search && request.carries ? { carried: exists ? guardCarriedPathsBelow(path, undefined, request.followsLinks === true) : [] } : {}),
                ...(request.operation === 'repository' ? { tracked: tracked.get(path) ?? null, ...request.history ? { committed: committed.get(path) ?? null } : {} } : {}),
                ...(request.operation === 'write' && exists && inspected.get(path)!.isFile() ? { links: inspected.get(path)!.nlink } : {}) }
        }
        const searchPath = data.searchPath ?? ''
        // Every spelling that names cockpit counts as cockpit, and with it the command a session or exec runs
        // after `--`, which the evaluator judges as one more invocation.
        type Launched = { readonly executable: string; readonly cwd: string; readonly argv: readonly string[]; readonly prefix: number; readonly nested?: true }
        const launched: Launched[] = []
        for (const invocation of parsed.invocations) {
            const prefix = cockpitLaunch(invocation)
            if (prefix === undefined) continue
            launched.push({ executable: invocation.executable!, cwd: invocation.cwd, argv: invocation.argv, prefix })
            const inner = innerCommand(invocation.argv.slice(prefix))
            const nested = inner && { executable: inner.words[0]!, argv: inner.words.slice(1) }
            const nestedPrefix = nested && cockpitLaunch(nested)
            if (nested && nestedPrefix !== undefined) launched.push({ ...nested, cwd: invocation.cwd, prefix: nestedPrefix, nested: true })
        }
        // Sync or upgrade would apply what the configuration last synced does not grant, and a person reviews it first.
        const applying = widening ? launched.find(entry => ['sync', 'upgrade'].includes(commandSpelling(entry.argv.slice(entry.prefix)).name ?? '')) : undefined
        if (applying) return refused({ decision: 'deny', reason: `Refusing to run cockpit ${commandSpelling(applying.argv.slice(applying.prefix)).name} while calls are judged under the configuration last synced: a person reviews ${identity.configPath} and syncs.` })
        // A spelling that does not name cockpit, such as a path into the package through `/./` or another
        // case, still runs it: any cockpit-shaped command naming sync or upgrade is held too.
        const packages = [...policy.cockpitPackageDirectories ?? [], ...policy.executionDirectories]
        const unproven = widening ? parsed.invocations.find(invocation => cockpitShaped(invocation, packages)
            && [invocation.executable ?? '', ...invocation.argv].some(word => /(?:^|:)(?:sync|upgrade)$/.test(word))) : undefined
        if (unproven) return refused({ decision: 'deny', reason: `Refusing to run cockpit ${[unproven.executable ?? '', ...unproven.argv].find(word => /(?:^|:)upgrade$/.test(word)) ? 'upgrade' : 'sync'} while calls are judged under the configuration last synced: a person reviews ${identity.configPath} and syncs.` })
        const authority = { grants: ordinaryGrants(config), profiles: agentProfiles(config), roots: prepared.result.policy.allowedRoots }
        // A cockpit command acts on the configuration it loads, so an agent's runs only on this guard's own,
        // resolved as the CLI resolves it, links included. Another has no guard of this one's to judge an
        // edit against, and sync would publish guards and settings from a file the agent wrote.
        const foreignConfiguration = (entry: Launched): string | undefined => {
            const target = commandConfiguration(entry.argv.slice(entry.prefix), entry.cwd)
            if (target === undefined) return undefined
            if (target === 'unclear') return 'a configuration its words do not settle'
            let loads = target
            try { loads = realpathSync(target) } catch (error) { if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return target }
            return loads === identity.configPath ? undefined : target
        }
        const foreign = launched.map(foreignConfiguration).find(target => target !== undefined)
        // A session inside a session would run a command the evaluator never sees.
        const cockpitInvocations: GuardInvocationProfile[] = launched.filter(entry => agentMayRun(entry.argv.slice(entry.prefix), { ...authority, cwd: entry.cwd })
            && foreignConfiguration(entry) === undefined && !(entry.nested && innerCommand(entry.argv.slice(entry.prefix))))
            .map(({ executable, cwd, argv }) => ({ executable, cwd, argv }))
        if (cockpitInvocations.length + prepared.result.policy.projectCommands.length > GUARD_INPUT_LIMITS.invocations) return unavailable('Guard candidates exceed the invocation bound.')
        const decision = evaluateGuard(parsed, { ...prepared.result.policy, cockpitInvocations,
            mcpAllowedTools: config.mcp.allowed_tools,
            searchDirectories: guardSearchDirectories(searchPath, prepared.result.policy.allowedRoots),
            // A write path still never takes a program planted in a search path directory, nor the Node the guard runs.
            ...agentAreas,
            ...policy.writePaths?.length || agentRoots.length ? { externalSearchDirectories: externalSearchDirectories(searchPath, policy.allowedRoots),
                guardRuntime: [...new Set([identity.node, node.canonicalPath, dirname(dirname(node.canonicalPath))])].filter(path => path !== '/') } : {},
            // The guard script on disk is the one the person's sync recorded, so staging it stages what a person ran sync for.
            ...inspectGuardRecord(identity.root) === 'match' ? { recordedGuardScript: true } : {},
            ripgrepConfigActive: data.ripgrepConfigActive === true }, inspect)
        // A Write or Edit of a skill, command or agent file is judged by the frontmatter it leaves; a file
        // too large to read leaves no text an edit can be proven against.
        const instruction = decision.decision === 'allow' ? instructionFrontmatterAsk(parsed, path => {
            try { const read = readBoundedFile(path, 1_048_576); return read.kind === 'complete' ? read.bytes.toString('utf8') : undefined }
            catch (error) { if (hasErrorCode(error, 'ENOENT')) return undefined; throw new CallPathUnreadable(path, error) }
        }) : undefined
        // Each of these reads costs a child process, so they run together; their results are checked in the order below.
        const publicationAfter = settle(readPublication())
        const moduleAfter = settle(read(dirname(identity.module), basename(identity.module), 16_777_216))
        const current = await adapters.loadConfig(policySource.path)
        if (current.kind !== 'complete' || current.result.source.sha256 !== policySource.sha256) return unavailable('Guard configuration changed during evaluation.')
        for (const [path, before] of [...roots, ...inspected]) {
            const after = lstatSync(path)
            // Directories may receive unrelated leaves, but replacement and file changes invalidate evidence.
            if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
                || before.isFile() && (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size)) return unavailable('Guard filesystem authority changed during evaluation.')
        }
        for (const [link, target] of readLinks) if (realpathSync(link) !== target) return unavailable('Guard read link target changed during evaluation.')
        const currentPublication = unwrap(await publicationAfter)
        for (const [path, hash] of [[manifestPath, manifestRead.sha256], [GUARD_LOCAL_PATHS.identity, publication.get(GUARD_LOCAL_PATHS.identity)!.sha256], ...published] as const) {
            if (currentPublication.get(path)!.sha256 !== hash) return unavailable('Guard publication changed during evaluation.')
        }
        if (unwrap(await moduleAfter).sha256 !== identity.moduleSha256) return unavailable('Guard handler changed during evaluation.')
        // A person may approve working in another cockpit, so the ask says that is what it is about. It holds
        // for a command that only reads too: one rule, whatever the command.
        const another = `Runs cockpit on ${foreign}, not ${identity.configPath}, the configuration this guard was generated from and judges by: an agent works in its own cockpit, so a person approves working in another.`
        const asked: GuardDecision = foreign === undefined || decision.decision === 'deny' || decision.decision === 'unavailable' ? decision
            : { decision: policy.unresolved === 'deny' ? 'deny' : 'ask', reason: decision.decision === 'ask' ? `${another} ${decision.reason}` : another }
        const judged = instruction ?? asked
        // This checkout's policy is anchored at its own root, so it does not cover an unsynced worktree's hook
        // registrations, MCP wrappers, instances or secret paths, and even a read there can print what the worktree's
        // own guard would hold. An allow stands only for `cd` and `pwd`: enough to leave. Any other call there is
        // refused, whatever this checkout's verdict, naming the commands that bind the worktree's own guard.
        if (data.unsyncedWorktree === true && !leaves && (judged.decision === 'allow' || bootstrap)) {
            const binds = !bootstrap ? '' : `, and, alone in a call from the worktree root ${bootstrap.root}, the command that binds the worktree's own guard to this `
                + `checkout's cockpit and configuration: \`${formatShellCommand(bootstrap.bind)}\`. Install the worktree's dependencies after that, under its own guard`
                + (bootstrap.refused ? `. The bind is not admitted: ${bootstrap.refused}` : '')
            return refused({ decision: 'deny', reason: `${parsed.cwd} is in a linked worktree where nobody has installed dependencies and synced cockpit, so it has no guard of its own. `
                + `Until it does, the checkout at ${identity.root} judges calls made there and admits only \`cd\` and \`pwd\`${binds}. `
                + `Otherwise change back to ${identity.root} with \`cd\`, or a person installs dependencies and syncs cockpit in the worktree.` })
        }
        // A path in another checkout of this repository is refused here even though a call made there is handed to that
        // checkout's own guard, so the refusal says where to run it. The decision stays this guard's.
        const elsewhere = judged.decision === 'allow' || !judged.reason.includes('escapes configured roots') ? undefined
            : [...outside, ...parsed.invocations.flatMap(invocation => [invocation.cwd, gitInvocation(invocation)?.cwd ?? invocation.cwd])]
                .map(path => otherCheckoutOfRepository(path, identity.root, policy.allowedRoots)).find(top => top !== undefined)
        if (elsewhere !== undefined) {
            const kind = checkoutOf(elsewhere)?.main === elsewhere ? 'the main checkout' : 'a linked worktree'
            return refused({ ...judged, reason: `${judged.reason} ${elsewhere} is ${kind} of this repository: run the command from there (cd ${elsewhere} first), where its own guard judges it.` })
        }
        return refused(judged)
    } catch (error) {
        if (error instanceof CallPathUnreadable) return unavailable(error.message)
        return unavailable(`Guard authority could not be read or revalidated: ${errorCause(error)}`)
    }
}

/**
 * Read and write paths as the guard holds them: `~/` is the home directory of whoever runs the agent, a
 * missing location grants nothing, a linked one is held to where it leads, and neither `/` nor the home
 * directory itself is ever granted.
 */
function canonicalOutsidePaths(paths: readonly string[]): readonly string[] {
    const home = realpathSync(homedir())
    return paths.flatMap(path => {
        const spelled = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
        try { return [realpathSync(spelled)] } catch (error) { if (hasErrorCode(error, 'ENOENT')) return []; throw error }
    }).filter(path => path !== '/' && path !== home)
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
// the policy read here grants nothing the last sync did not. An agent resets only where a declared seed
// refills the data a reset deletes.
function ordinaryGrants(config: CockpitConfig): readonly OrdinaryGrant[] {
    return [...config.browser && browserPreapprovalRequested(config.browser) ? ['browser-preapproval' as const] : [],
        ...config.environment.seed ? ['seeded-reset' as const] : []]
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
    /** The cockpit.toml the policy speaks for, when the configuration was read from the record of it sync keeps. */
    readonly configPath?: string
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
    const inputData = ownDataValues(input, ['configuration', 'checkout'], ['configPath'])
    const data = inputData && Object.hasOwn(inputData, 'configuration') && Object.hasOwn(inputData, 'checkout') ? inputData : undefined
    if (!data || data.configPath !== undefined && (typeof data.configPath !== 'string' || !isAbsolute(data.configPath))) {
        return guardPolicyRefusal('guard policy requires own-data configuration and checkout observations')
    }
    const configuration = data.configuration as LoadedConfigProjection
    const exposed = snapshotJson(configuration)
    const loaded = consumeLoadedConfigProjection(configuration)
    if (!loaded || !exposed || !isDeepStrictEqual(exposed, snapshotJson(loaded))) {
        return guardPolicyRefusal('guard policy configuration authority is copied, changed or already consumed')
    }
    const configPath = (data.configPath as string | undefined) ?? loaded.source.path
    const cockpitRoot = dirname(configPath)
    const derived = deriveRegistry(loaded.config)
    if (derived.kind !== 'complete') return guardPolicyRefusal(`guard policy registry refused (${derived.code}): ${derived.message}`)
    const guardConfig = CockpitConfig.parse(derived.result.config)
    const recorded = await (siblingCheckouts ?? readSiblingCheckouts(cockpitRoot))
    if (recorded.kind === 'refusal') return guardPolicyRefusal(recorded.diagnostic.message)
    const served = servedSiblings(cockpitRoot, guardConfig, recorded.checkouts)
    const observed = snapshotJson(data.checkout) as SetupCheckoutObservation | undefined
    if (observed?.state !== 'available') {
        const root = cockpitRoot
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
            const canonicalRoot = directory(cockpitRoot)
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
            const relatedSpellings = config.guards.related_checkouts.map(spelled => relatedCheckoutPath(spelled, canonicalRoot, homedir()))
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
                ripgrepConfigActive: false, externalReads: config.guards.external_reads,
                unresolved: config.guards.unresolved,
                homeDirectory: realpathSync(homedir()),
                // A related checkout is granted only where it already exists under exactly the spelling declared: a
                // missing one, or one reached through a link, could be a link an agent made to anywhere it likes.
                relatedCheckouts: relatedSpellings.flatMap(path => {
                    let real: string
                    try { real = realpathSync(path) } catch (error) { if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return []; throw error }
                    const home = realpathSync(homedir())
                    // The filesystem root, the home directory or a directory above it is no checkout, and one
                    // overlapping a managed root would make that root read-only.
                    if (real !== path || !lstatSync(real).isDirectory() || real === '/' || confinedPath(real, home)
                        || [...allowedRoots].some(root => confinedPath(root, real)) || relatedCheckoutHoldsRoot(real, allowedRoots)) return []
                    return [real]
                }),
                // Every declared spelling and its missing ancestors stay unwritten, so no agent can create one. A
                // spelling that is a root or holds one names no other checkout: one cockpit.toml serves every
                // checkout of a product, and reserving its own root refused every write in it.
                relatedReserved: [...new Set(relatedSpellings.filter(path => !relatedCheckoutHoldsRoot(path, allowedRoots)).flatMap(path => {
                    const reserved = [path]
                    for (let cursor = dirname(path); cursor !== '/' && !lstatIfPresentSync(cursor); cursor = dirname(cursor)) reserved.push(cursor)
                    return reserved
                }))],
                // One holding the home directory would admit every shell startup file below it.
                writePaths: canonicalOutsidePaths(config.guards.write_paths.map(({ path }) => path)).filter(path => !confinedPath(path, realpathSync(homedir()))),
                readPaths: canonicalOutsidePaths(config.guards.read_paths.map(({ path }) => path)),
                secretPaths,
                executionDirectories, cockpitPackageDirectories, searchDirectories: [],
                secretFileIdentities: secretFiles.identities && [...secretFiles.identities], protectedFilesLinked,
                cockpitInvocations: [], projectCommands: [],
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

/**
 * The plain commands a shell command line runs, as the guard reads them for a Bash call in `cwd`;
 * undefined for a line the guard does not read as plain commands.
 */
export function guardCommandInvocations(command: string, cwd: string): readonly ParsedInvocation[] | undefined {
    const parsed = parseGuardInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } })
    return parsed.status === 'parsed' && !parsed.unreadable ? parsed.invocations.filter(row => row.executable !== null) : undefined
}
