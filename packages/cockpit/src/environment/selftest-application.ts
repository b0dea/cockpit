import { exactKeys } from '../exact-keys.js'
import { randomBytes } from 'node:crypto'
import { sha256Hex } from '../sha256.js'
import { constants, existsSync } from 'node:fs'
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { confirmDigest } from '../operator-confirmation.js'
import { renderHumanValue } from '../diagnostics.js'
import { isDeepStrictEqual, types as utilTypes } from 'node:util'
import { MODEL_INPUT_PROTOCOLS, claudeImportPaths, foreignClaudeComment, nativeClaudeImport, nativeInputSettings, nativeSkillBody, validateNativeModelInputPair } from '../../libexec/native-selftest-input.mjs'
import { startSelftestModel } from './selftest-model.js'
import { brokenNativeGuardSettings, nativeGuardCommands, nativeGuardInterference, validateNativeGuardPair } from '../../libexec/native-selftest-guard.mjs'

import {
    PROBE_EVIDENCE_ROOT, NATIVE_SELFTEST_STREAM_BYTES, validateNativeInstructionPair,
    validateSelftestEvidenceBundle,
    type SelftestEvidenceBundle,
    type SelftestEvidenceRecord,
    type SelftestProbeEvent,
} from '../../libexec/validate-harness-evidence.mjs'
import { authenticatedExecutionOutcome, changedExecutionInput, executeProbe, type ExecuteProbeOutcome, type ForegroundProcessOutcome } from '../environment-exec/execute.js'
import type { Diagnostic } from '../diagnostics.js'
import { generatedApplicationProjection, generatedSelftestGuardHandler, generatedSelftestGuardRuntime } from './generated-application/authorities.js'
import { readBoundedInput } from '../config/load.js'
import { GUARD_HELD_CALLS } from '../surfaces/harness-registry.js'
import { GUARD_LOCAL_PATHS, parseGuardLocalIdentity, type GuardHandlerIdentity } from '../guards/local-identity.js'
import { checkGeneratedEnvironment } from './generated-application/check.js'
import { type GeneratedApplicationProjection } from './generated-application/shared.js'
import { redactSensitiveMessage } from './sensitive.js'
import {
    snapshotExecutionStep, snapshotGeneratedJson, ENVIRONMENT_CODES, errorCause, hasErrorCode, INHERITED_TOOL_ENVIRONMENT, type ConsumedFile, type ExecutionStep, type FilesystemCheck,
} from './contract.js'
import { resolveExecutable, resolveExecutablePath, type ResolvedExecutable } from './executable.js'
import { cockpitCommand, formatShellCommand } from '../fix-catalogue.js'
import {
    draftSurfaceSelftestSpecifications,
    planSurfaceSelftest,
    unfilledSurfaceSelftestSpecifications,
    surfaceSelftestCellLabel,
    surfaceSelftestHumanNeeded,
    surfaceSelftestReviews,
    type PlannedSelftestProbe,
    type SelftestExpectation,
    type SelftestHumanNeededRecord,
    type SelftestProbeSpecification,
} from '../surfaces/selftest.js'

export interface ConfiguredSurfaceSelftestCommandInput {
    readonly configPath: string
    readonly probeSpecificationsPath: string
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface SurfaceSelftestDraftInput {
    readonly configPath: string
    readonly writeProbeSpecificationsPath: string
    /** An earlier probe-specification file whose filled rows for unchanged cells carry into the new one. */
    readonly previousProbeSpecificationsPath?: string
    /** Write over an existing file at the path: the person asked for their own file to be replaced. */
    readonly replace?: boolean
}

export interface SurfaceSelftestCommandInput {
    readonly application: GeneratedApplicationProjection
    readonly root: string
    readonly specifications: readonly SelftestProbeSpecification[]
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface SurfaceSelftestExecutableCandidate {
    readonly harness: 'Claude Code' | 'Codex' | 'OpenCode'
    readonly canonicalPath: string
    readonly sha256: string
}

export interface SurfaceSelftestProbeSpecificationsCandidate {
    readonly canonicalPath: string
    readonly sha256: string
    readonly sourceSha256: string
    readonly generatedManifestSha256: string
    readonly commandVectors: readonly Readonly<{
        harness: string
        capability: string
        skill: string | null
        invocation: readonly [string, ...string[]]
        protocol?: string
        executes?: boolean
        versionCommand: readonly [string, ...string[]]
        helpCommand: readonly [string, ...string[]]
    }>[]
    /** Hook registrations beside cockpit's own in the settings the Claude Code guard probe loads, one line each. */
    readonly guardProbeTeamHooks?: readonly string[]
}

export interface SurfaceSelftestCommandAdapters {
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    readonly requestExecutableApproval?: (candidate: SurfaceSelftestExecutableCandidate) => Promise<string | undefined>
    readonly requestProbeSpecificationsApproval?: (
        candidate: SurfaceSelftestProbeSpecificationsCandidate,
    ) => Promise<string | undefined>
    readonly testOnlyExecutableIdentities?: Partial<Record<'Claude Code' | 'Codex' | 'OpenCode', readonly string[]>>
    /**
     * Runs this same selftest again under `node`, whose path and digest match what sync recorded for
     * the guard, with the terminal attached. Bound only for a person's interactive run that is not
     * itself such a rerun, so a rerun that meets a mismatch refuses instead of looping.
     */
    readonly rerunUnderNode?: (node: ResolvedExecutable) => Promise<ForegroundProcessOutcome>
}

export type SurfaceSelftestCommandOutcome =
    | Readonly<{
        kind: 'complete'
        status: 0
        root: string
        bundle: SelftestEvidenceBundle
        evidence: ReturnType<typeof validateSelftestEvidenceBundle>
        /** Every cell with a supported protocol produced evidence. */
        measurementComplete: boolean
    }>
    // At least one cell's measurement failed; its record names why, and every other cell was still measured.
    | Readonly<{
        kind: 'incomplete'
        status: 2
        root: string
        bundle: SelftestEvidenceBundle
        evidence: ReturnType<typeof validateSelftestEvidenceBundle>
        /** Every cell with a supported protocol produced evidence. */
        measurementComplete: boolean
    }>
    | Readonly<{ kind: 'refusal'; status: 2; code: 'SELFTEST_SOURCE_INVALID' | 'SELFTEST_EXECUTION_INVALID' | 'SELFTEST_GUARD_IDENTITY_MISMATCH'; reason: string; fix?: string }>
    // The run continued under the Node the guard runs, which printed its own outcome; this is its exit
    // status, and the signal that ended it when one did.
    | Readonly<{ kind: 'rerun'; status: number; signal?: NodeJS.Signals }>

const defaultAdapters: SurfaceSelftestCommandAdapters = Object.freeze({ execute: executeProbe })
const MAX_EXECUTABLE_BYTES = 536_870_912
const MAX_CONTROL_BYTES = 65_536
const MAX_PROBE_SPECIFICATIONS_BYTES = 1_048_576
const STREAM_BYTES = 65_536
const PROBE_TIMEOUT_MS = 30_000
const EVIDENCE_EXPIRY_MS = 300_000
const BUILTIN_EXECUTABLES = Object.freeze({ claudecode: 'claude', codexcli: 'codex', opencode: 'opencode' } as const)
// Why a custom cell has no probe row; see SelftestProbeSpecification.
const UNPROBEABLE_REASON = 'selftest runs only built-in tools it found on PATH and you approved by digest, and a custom harness has no such executable'
const UNPROBEABLE_ACTION = 'measure the capability by hand with a candidate and a deliberately broken control and record it in cockpit.toml'

// A signed-in tool locates its stored sign-in through HOME, so a probe given PATH alone reports
// every cell as not signed in. The allowlist carries no credential; every other variable, tokens
// included, stays out of the probe.
const PROBE_ENVIRONMENT: ReadonlySet<string> = new Set(['PATH', ...INHERITED_TOOL_ENVIRONMENT])

function captureProbeEnvironment(value: unknown): Readonly<Record<string, string | undefined>> | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return undefined
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return undefined
        const keys = Reflect.ownKeys(value)
        if (keys.length > 4_096) return undefined
        const env: Record<string, string | undefined> = {}
        for (const key of keys) {
            if (typeof key !== 'string' || !PROBE_ENVIRONMENT.has(key)) continue
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
                || descriptor.value !== undefined && (typeof descriptor.value !== 'string'
                    || Buffer.byteLength(descriptor.value) > 65_536)) return undefined
            env[key] = descriptor.value
        }
        return env
    } catch { return undefined } // A throwing accessor or proxy trap makes the input malformed; the caller refuses it.
}

function commandInput(value: unknown): SurfaceSelftestCommandInput | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const { application, env: rawEnv, root, specifications } = value as Record<string, unknown>
    const env = captureProbeEnvironment(rawEnv)
    if (typeof root !== 'string' || !env || !Array.isArray(specifications)) return undefined
    return { application, root, specifications, env } as SurfaceSelftestCommandInput
}

function configuredCommandInput(value: unknown): ConfiguredSurfaceSelftestCommandInput | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const { configPath, env: rawEnv, probeSpecificationsPath } = value as Record<string, unknown>
    const env = captureProbeEnvironment(rawEnv)
    if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')
        || typeof probeSpecificationsPath !== 'string' || probeSpecificationsPath.length === 0
        || probeSpecificationsPath.includes('\0') || !env) return undefined
    return { configPath, probeSpecificationsPath, env }
}

function refusal(code: Extract<SurfaceSelftestCommandOutcome, { kind: 'refusal' }>['code'], reason: string): SurfaceSelftestCommandOutcome {
    return { kind: 'refusal', status: 2, code, reason }
}

// A string is the file's text, `undefined` a file that is not a bounded regular file, and `{ cause }` an I/O or decoding failure.
async function readProbeSpecificationsArtifact(path: string): Promise<string | Readonly<{ cause: string }> | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        const before = await lstat(path)
        if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PROBE_SPECIFICATIONS_BYTES) return undefined
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await handle.stat()
        if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) return undefined
        const chunks: Buffer[] = []
        const chunk = Buffer.allocUnsafe(STREAM_BYTES)
        let total = 0
        while (true) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, MAX_PROBE_SPECIFICATIONS_BYTES - total + 1), null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > MAX_PROBE_SPECIFICATIONS_BYTES) return undefined
            chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
        }
        const after = await handle.stat()
        if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return undefined
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))
    } catch (error) { return { cause: errorCause(error) } } finally { await handle?.close() }
}

const PROBE_SPECIFICATIONS_SCHEMA = 'cockpit-selftest-probe-specifications/v1'

// The file carries no digest of its own rows: a person edits them, and a digest anyone can
// recompute would prove nothing. What binds the rows is the approval of the whole file's SHA-256.
function probeSpecificationsArtifact(
    bytes: string,
    sourceSha256: string,
    generatedManifestSha256: string,
): Readonly<{ kind: 'complete' | 'stale'; specifications: readonly unknown[] }> | Readonly<{ kind: 'malformed'; cause?: string }> {
    let captured: Readonly<Record<string, unknown>> | undefined
    try { captured = snapshotGeneratedJson(JSON.parse(bytes)) as Readonly<Record<string, unknown>> | undefined } catch (error) { return { kind: 'malformed', cause: errorCause(error) } }
    if (!captured || !exactKeys(captured, ['generatedManifestSha256', 'schema', 'sourceSha256', 'specifications'])
        || captured.schema !== PROBE_SPECIFICATIONS_SCHEMA || !Array.isArray(captured.specifications)) return { kind: 'malformed' }
    if (captured.sourceSha256 !== sourceSha256 || captured.generatedManifestSha256 !== generatedManifestSha256) {
        return { kind: 'stale', specifications: captured.specifications }
    }
    return { kind: 'complete', specifications: captured.specifications }
}

function causeSuffix(cause: string | undefined): string {
    return cause ? `: ${cause}` : ''
}

// Every refusal about the file itself names the command that writes a fresh one.
function probeSpecificationsRefusal(reason: string): SurfaceSelftestCommandOutcome {
    return {
        kind: 'refusal', status: 2, code: 'SELFTEST_SOURCE_INVALID', reason,
        fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config <your cockpit.toml> --interactive, which writes fresh probe specifications itself; to keep a file under review instead, write one with ./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config <your cockpit.toml> --write-probe-specifications <new file>, review it, then pass that file to --probe-specifications',
    }
}

type BuiltinHarnessName = 'Claude Code' | 'Codex' | 'OpenCode'
type OperatorExecutableIdentities = Map<BuiltinHarnessName, Readonly<{ canonicalPath: string; sha256: string }>>

async function hasExecutableAuthority(
    adapters: SurfaceSelftestCommandAdapters,
    approved: OperatorExecutableIdentities,
    harness: BuiltinHarnessName,
    executable: ResolvedExecutable,
): Promise<boolean> {
    const operatorIdentity = approved.get(harness)
    if (operatorIdentity?.canonicalPath === executable.canonicalPath && operatorIdentity.sha256 === executable.sha256) return true
    if (adapters.requestExecutableApproval) {
        const confirmation = await adapters.requestExecutableApproval({
            harness, canonicalPath: executable.canonicalPath, sha256: executable.sha256,
        })
        if (confirmation === executable.sha256) {
            approved.set(harness, { canonicalPath: executable.canonicalPath, sha256: executable.sha256 })
            return true
        }
    }
    if (process.env.NODE_ENV === 'test') {
        const identities = adapters.testOnlyExecutableIdentities?.[harness]
        if (!Array.isArray(identities)) return false
        for (const identity of identities) {
            if (typeof identity !== 'string' || !isAbsolute(identity) || identity.includes('\0')) continue
            try {
                if (await realpath(identity) === executable.canonicalPath) return true
            } catch { continue } // An unresolvable test identity cannot match; the next one is tried and none matching refuses.
        }
    }
    return false
}

function relativeEvidencePath(root: string, path: string): string | undefined {
    const offset = relative(root, path)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
        ? offset.split(sep).join('/') : undefined
}

function exactLine(value: string, code: string): boolean {
    return value.split(/\r?\n/).some((line) => line.trim() === code)
}

function boundedStream(value: Buffer, limit = STREAM_BYTES): string | undefined {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(value) } catch { return undefined } // Fatal decoding throws only for invalid UTF-8, which the caller rejects as an unusable stream.
    const redacted = redactSensitiveMessage(text)
    if (redacted === undefined) return undefined
    text = redacted
    if (Buffer.byteLength(text) > limit) return undefined
    return text
}

function step(
    id: string,
    root: string,
    argv: readonly [string, ...string[]],
    argv0: string,
    consumedFiles: readonly ConsumedFile[],
    deadline: number,
    labels: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>>,
    filesystemChecks: readonly FilesystemCheck[] = [],
    streamBytes = STREAM_BYTES,
): ExecutionStep | undefined {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    return snapshotExecutionStep({
        id, argv, argv0, cwd: root, env, timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining),
        spawnNotAfter: new Date(deadline).toISOString(), stdoutLimitBytes: streamBytes, stderrLimitBytes: streamBytes,
        paths: [root], ports: [], labels, expected: [], consumedFiles, filesystemChecks, compensation: [],
    })
}

type ChangedInput = Awaited<ReturnType<typeof changedExecutionInput>>

async function run(
    adapters: SurfaceSelftestCommandAdapters,
    value: ExecutionStep | undefined,
    role: string,
): Promise<{ outcome: ExecuteProbeOutcome; startedAt: string; finishedAt: string; changedInput?: ChangedInput } | ProbeFailure | RunFailure> {
    if (!value) return { probeFailure: `the ${role} step could not start within the probe's ${EVIDENCE_EXPIRY_MS / 60_000}-minute evidence window and step bounds; rerun selftest` }
    const startedAt = new Date().toISOString()
    const outcome = authenticatedExecutionOutcome(await adapters.execute(value), value)
    const finishedAt = new Date().toISOString()
    if (!outcome) return { runFailure: `the ${role} step's result is not bound to the step cockpit ran; rerun selftest` }
    // The executor's refusal says only that some bound input failed; re-checking them names which.
    return outcome.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED
        ? { outcome, startedAt, finishedAt, changedInput: await changedExecutionInput(value) }
        : { outcome, startedAt, finishedAt }
}

// Executor refusals that are not confined to one cell: a reviewed input changed, staging cannot be
// trusted, a probe process may outlive its step, or the person aborted the run.
const RUN_STOPPING_EXECUTIONS: Readonly<Partial<Record<string, string>>> = {
    [ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED]: 'an input this reviewed run consumed changed while it ran (the approved executable, cockpit\'s guard runtime or a probe control); review what changed, then rerun selftest',
    [ENVIRONMENT_CODES.EXECUTION_STAGING_FAILED]: 'the executor could not stage the step\'s inputs; check the probe directory, then rerun selftest',
    [ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED]: 'the executor could not clean up the step\'s staged inputs; check the probe directory, then rerun selftest',
    [ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED]: 'a probe process may still be running; stop it, then rerun selftest',
    [ENVIRONMENT_CODES.EXECUTION_ABORTED]: 'the run was aborted',
}

function runStop(role: string, row: Awaited<ReturnType<typeof run>>, describeInput: (path: string) => string): RunFailure | undefined {
    if ('runFailure' in row) return row
    if (!('outcome' in row) || row.outcome.kind !== 'refusal') return undefined
    const changed = row.changedInput
    const reason = changed?.kind === 'changed' ? `${describeInput(changed.path)} changed after this run bound it; review what changed, then rerun selftest`
        : changed?.kind === 'expired' ? `the step's dispatch window, which ends with the probe's ${EVIDENCE_EXPIRY_MS / 60_000}-minute evidence window, closed before it started; rerun selftest`
            : RUN_STOPPING_EXECUTIONS[row.outcome.code]
    return reason === undefined ? undefined : { runFailure: `the ${role} step was refused with ${row.outcome.code}: ${reason}` }
}

function publicCommand(command: readonly string[], executable: string, control?: string): readonly [string, ...string[]] {
    return command.map((value) => value === '{executable}' ? executable
        : value === '{control}' && control !== undefined ? control : value) as [string, ...string[]]
}

function executionCommand(command: readonly [string, ...string[]], root: string, control?: string): readonly [string, ...string[]] {
    return command.map((value) => value === control && control !== undefined ? resolve(root, control) : value) as [string, ...string[]]
}

function event(
    command: readonly string[],
    cwd: string,
    execution: ExecuteProbeOutcome,
    result: SelftestProbeEvent['result'],
    code: string,
    streamBytes = STREAM_BYTES,
): SelftestProbeEvent | undefined {
    const stdout = boundedStream(execution.stdout, streamBytes)
    const stderr = boundedStream(execution.stderr, streamBytes)
    if (stdout === undefined || stderr === undefined) return undefined
    return {
        cwd, command: [...command], exitCode: execution.execution.exitCode,
        signal: execution.execution.signal, result, code, stdout, stderr,
        stdoutSha256: sha256Hex(stdout), stderrSha256: sha256Hex(stderr),
    }
}

function selectedEntryBytes(probe: PlannedSelftestProbe): string | undefined {
    // The tools load the root AGENTS.md whole; without those bytes there is nothing honest to measure.
    if (probe.capability === 'instruction-loading') return probe.instructionFile
    const selected = probe.entries.find((entry) => {
        if (probe.cell.capability === 'skill-parity') return entry.path.includes(`/skills/${probe.cell.skill}/`)
        if (probe.harness.kind !== 'builtin') return false
        // Every built-in tool loads cockpit's instructions and the copied sibling guides from the root AGENTS.md.
        if (probe.capability === 'instruction-loading') return entry.path === 'AGENTS.md'
        if (probe.harness.target === 'claudecode') return entry.path === '.claude/settings.json'
        if (probe.harness.target === 'codexcli') return entry.path === '.codex/config.toml'
            || entry.path.startsWith('.codex/rules/')
        return entry.path === 'opencode.jsonc'
    })
    if (!selected) return undefined
    if (selected.kind === 'file') return selected.bytes
    return selected.region.format === 'markdown-delimited'
        ? selected.region.bytes
        : `${JSON.stringify(Object.fromEntries(selected.region.members.map((member) => [member.key, JSON.parse(member.valueBytes)])), null, 2)}\n`
}

function authenticationRequired(outcome: ExecuteProbeOutcome): boolean {
    const text = `${outcome.stdout.toString('utf8')}\n${outcome.stderr.toString('utf8')}`
    return /(?:not authenticated|not logged in|authentication required|unauthorized|\b401\b|\b403\b)/i.test(text)
}

// Returns undefined for a plain directory, otherwise why it is not one.
async function ensurePlainDirectory(path: string): Promise<string | undefined> {
    const inspect = async (): Promise<string | undefined> => {
        const status = await lstat(path)
        return status.isDirectory() && !status.isSymbolicLink() && await realpath(path) === path
            ? undefined : `${path} is not a plain directory`
    }
    try {
        return await inspect()
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) return `${path} could not be inspected: ${errorCause(error)}`
        try { await mkdir(path, { mode: 0o700 }) } catch (createError) {
            if (!hasErrorCode(createError, 'EEXIST')) return `${path} could not be created: ${errorCause(createError)}`
        }
        try { return await inspect() } catch (inspectError) {
            return `${path} could not be inspected: ${errorCause(inspectError)}`
        }
    }
}

async function ensureEvidenceDirectory(root: string): Promise<string | Readonly<{ reason: string }>> {
    try {
        if (await realpath(root) !== root) return { reason: `${root} is not canonical` }
        let directory = root
        for (const segment of PROBE_EVIDENCE_ROOT.split('/')) {
            directory = join(directory, segment)
            const problem = await ensurePlainDirectory(directory)
            if (problem) return { reason: problem }
        }
        return directory
    } catch (error) { return { reason: `${root} could not be resolved: ${errorCause(error)}` } }
}

// A cell whose measurement could not run or could not be judged, with what failed and what to do.
// The run records it for that cell and measures the rest.
type ProbeFailure = Readonly<{ probeFailure: string }>
// The reviewed inputs changed or cannot be trusted, or evidence cannot be kept apart from the
// checkout: no further measurement means anything, so the run stops.
type RunFailure = Readonly<{ runFailure: string }>

async function writeControlPair(
    directory: string,
    probe: PlannedSelftestProbe,
    guardHookCommand: string | undefined,
): Promise<{ candidate: string; broken: string; candidateSha256: string; brokenSha256: string; brokenBytes: string; brokenHookCommand?: string } | ProbeFailure> {
    const guard = probe.protocol === 'claude-guard-loopback/v1'
    const modelInput = MODEL_INPUT_PROTOCOLS.includes(probe.protocol ?? '')
    const native = probe.protocol === 'codex-prompt-input/v1' || modelInput
    if (native) {
        // Codex 0.167.0 on 2026-11-06 applied its instruction limit to the whole AGENTS.md chain up to the
        // nearest .git. Under the cockpit root, a guide over half the limit cut its own copy, though a session
        // loads the root file whole. This marker ends the chain here: 32,000 bytes then loaded, 40,000 did not.
        await mkdir(join(directory, '.git'), { mode: 0o700 })
        await mkdir(join(directory, 'candidate'), { mode: 0o700 })
        await mkdir(join(directory, 'broken'), { mode: 0o700 })
    }
    const skillPath = modelInput && probe.sample ? join(probe.harness.target === 'claudecode' ? '.claude' : '.agents', 'skills', probe.sample.skill, 'SKILL.md') : undefined
    if (skillPath) for (const role of ['candidate', 'broken']) await mkdir(dirname(join(directory, role, skillPath)), { recursive: true, mode: 0o700 })
    const candidate = native ? join(directory, 'candidate', skillPath ?? 'AGENTS.md') : join(directory, 'candidate.json')
    const broken = native ? join(directory, 'broken', skillPath ?? 'AGENTS.md') : join(directory, 'broken.json')
    const candidateBytes = selectedEntryBytes(probe)
    if (!candidateBytes) return { probeFailure: 'the generated file this probe loads is not among the published surfaces; run sync, then rerun selftest' }
    if (Buffer.byteLength(candidateBytes) > MAX_CONTROL_BYTES) return { probeFailure: `the generated file this probe loads is larger than the ${MAX_CONTROL_BYTES} bytes a probe control holds, so the capability cannot be measured here; measure it by hand with a candidate and a deliberately broken control` }
    const replacement = `Cockpit selftest replacement control ${randomBytes(12).toString('hex')}.\n`
    const brokenHookCommand = guard ? `cockpit-selftest-missing-hook-${randomBytes(12).toString('hex')}` : undefined
    const brokenGuard = guard ? brokenNativeGuardSettings(candidateBytes, guardHookCommand, brokenHookCommand!) : undefined
    if (brokenGuard?.problem !== undefined) return { probeFailure: brokenGuard.problem }
    const brokenBytes = brokenGuard ? brokenGuard.bytes : skillPath && probe.harness.target === 'claudecode'
        ? `---\nname: ${probe.sample!.skill}\ndescription: Cockpit selftest broken control.\nuser-invocable: false\n---\n${replacement}`
        : native ? replacement : '{\n'
    if (modelInput || guard) {
        await mkdir(join(directory, 'home'), { mode: 0o700 })
        await mkdir(join(directory, 'home', '.codex'), { mode: 0o700 })
        await mkdir(join(directory, 'home', '.claude'), { mode: 0o700 })
        if (!guard && probe.harness.target === 'claudecode') for (const role of ['candidate', 'broken']) {
            await writeFile(join(directory, role, 'native-settings.json'), nativeInputSettings(join(directory, role)), { flag: 'wx', mode: 0o600 })
        }
        if (probe.capability === 'instruction-loading') {
            const wrapper = probe.entries.find(entry => entry.path === 'CLAUDE.md')
            const bytes = wrapper?.kind === 'file' ? wrapper.bytes : wrapper?.region.format === 'markdown-delimited' ? wrapper.region.bytes : probe.teamClaudeGuide
            if (!bytes || !nativeClaudeImport(bytes)) return { probeFailure: 'the generated CLAUDE.md is missing or does not import AGENTS.md, so the Claude Code instruction probe cannot load the guide through it; run sync to restore it, then rerun selftest' }
            for (const role of ['candidate', 'broken']) await writeFile(join(directory, role, 'CLAUDE.md'), bytes, { flag: 'wx', mode: 0o600 })
        }
    }
    await writeFile(candidate, candidateBytes, { flag: 'wx', mode: 0o600 })
    await writeFile(broken, brokenBytes, { flag: 'wx', mode: 0o600 })
    return { candidate, broken, candidateSha256: sha256Hex(candidateBytes), brokenSha256: sha256Hex(brokenBytes), brokenBytes,
        ...(brokenHookCommand ? { brokenHookCommand } : {}) }
}

function consumedExecutable(executable: ResolvedExecutable): ConsumedFile {
    return {
        path: executable.canonicalPath, sha256: executable.sha256, maxBytes: MAX_EXECUTABLE_BYTES,
        argvIndexes: [0], executable: true, executionMode: executable.executionMode,
    }
}

// Over-inclusive on purpose: it only narrows which registrations a failure names, and Claude Code's
// reading of an unusual matcher is unmeasured, so anything that might select Bash stays listed.
function mayMatchBash(matcher: unknown): boolean {
    if (typeof matcher !== 'string' || matcher === '' || matcher === '*') return true
    try { return new RegExp(matcher).test('Bash') } catch { return true } // an invalid pattern is kept listed, as above
}

// A team's own PreToolUse hook runs beside cockpit's guard under both controls. When one refuses a
// probe command, the paired measurement cannot complete, and that is the person's to resolve: the
// failure names the hook and asks for the probe's two commands to pass, never for the hook to go.
function guardInterference(
    probe: PlannedSelftestProbe,
    guardHookCommand: string | undefined,
    streams: Readonly<{ broken: string; candidate: string }>,
): string | undefined {
    const refused = [...new Set((['broken', 'candidate'] as const).flatMap(role => nativeGuardInterference(streams[role]).map(reason =>
        `${role} control: ${redactSensitiveMessage(reason) ?? 'reason withheld because it looked like a credential'}`)))]
    if (refused.length === 0) return undefined
    // These bytes already parsed when the broken control was derived from them.
    const groups: unknown = JSON.parse(selectedEntryBytes(probe)!).hooks?.PreToolUse
    const beside = (Array.isArray(groups) ? groups : []).filter(group => mayMatchBash(group?.matcher))
        .flatMap(group => (Array.isArray(group.hooks) ? group.hooks : [])
            .filter((hook: { command?: unknown }) => typeof hook?.command === 'string' && hook.command !== guardHookCommand)
            .map((hook: { command: string }) => `matcher ${JSON.stringify(group.matcher ?? '')} runs ${hook.command}`))
    const commands = nativeGuardCommands(probe.guardHost!, '<port>', '<nonce>')
    return `a PreToolUse hook beside cockpit's guard refused a probe command, so the paired guard measurement could not complete (${refused.join('; ')})`
        + (beside.length > 0 ? `. ${beside.length === 1 ? 'The registration' : 'The registrations'} beside cockpit's guard that can select Bash: ${beside.join('; ')}` : '')
        + `. Let that hook pass the probe's two Bash commands, \`${commands.allowedCommand}\` and \`${commands.forbiddenCommand}\`, which reach only a local loopback listener, while it keeps every other check it makes; then rerun selftest, or measure guard-firing by hand with a candidate and a deliberately broken control`
}

// A token imports content into the probe, or into a real session, only when it can reach a file: an
// absolute, home or parent-relative path, or one naming a file beside the guide in the cockpit root.
// Package names and handles in prose ("@acme/ui", "@jane.doe") resolve to nothing.
function probeImports(bytes: string, root: string): string[] {
    return claudeImportPaths(bytes).filter(path => path !== 'AGENTS.md'
        && (/^[~/]/.test(path) || path.split('/').includes('..') || existsSync(resolve(root, path))))
}

async function runEvidenceProbe(
    root: string,
    evidenceRoot: string | Readonly<{ reason: string }>,
    expectation: SelftestExpectation,
    probe: PlannedSelftestProbe,
    env: SurfaceSelftestCommandInput['env'],
    adapters: SurfaceSelftestCommandAdapters,
    approvedExecutables: OperatorExecutableIdentities,
    guardRuntime: ReturnType<typeof generatedSelftestGuardRuntime>,
    guardHandler: GuardHandlerIdentity | undefined,
): Promise<SelftestEvidenceRecord | SelftestHumanNeededRecord | ProbeFailure | RunFailure> {
    const harnessName = probe.harness.name
    const observedAt = new Date().toISOString()
    const humanNeeded = (reason: SelftestHumanNeededRecord['reason'], operatorAction: string): SelftestHumanNeededRecord | RunFailure =>
        surfaceSelftestHumanNeeded(expectation, probe.cell, reason, observedAt, operatorAction)
            ?? { runFailure: `the ${reason} finding could not be recorded as human_needed: ${operatorAction}` }
    if (probe.protocol === 'native-unsupported/v1') {
        // The Claude guard probe needs a request the guard refuses; without a declared vendor host it has none.
        if (probe.harness.target === 'claudecode' && probe.capability === 'guard-firing') return humanNeeded('guard_host_undeclared',
            'Claude Code guard firing is measured by asking the guard to refuse a request to a host declared under [guards] vendor_endpoint_hosts, and cockpit.toml declares none. Declare a vendor endpoint host your agents must not call directly, run sync, then write fresh probe specifications and rerun selftest; the probe points that host at a local listener and sends nothing out.',
        )
        return humanNeeded('native_protocol_unsupported', probe.harness.target === 'codexcli' && probe.capability === 'guard-firing'
            ? 'cockpit cannot measure Codex guard firing yet, so this cell stays pending on every run; nothing you change clears it.'
            : `cockpit has no native selftest protocol for ${harnessName} ${probe.capability} yet, so this cell stays pending on every run; nothing you change clears it.`)
    }
    const guard = probe.protocol === 'claude-guard-loopback/v1'
    if (guard && (!guardRuntime || !guardRuntime.some(file => file.path === join(root, '.cockpit/guards/bash-guard.sh')))) return { runFailure: 'native guard runtime is not bound to this published cockpit root; run sync, then rerun selftest' }
    const modelInput = MODEL_INPUT_PROTOCOLS.includes(probe.protocol ?? '') || guard
    const native = probe.protocol === 'codex-prompt-input/v1' || modelInput
    const guideImports = modelInput && probe.harness.target === 'claudecode' && probe.capability === 'instruction-loading'
        ? probeImports(selectedEntryBytes(probe) ?? '', root) : []
    if (guideImports.length > 0) return humanNeeded('native_protocol_unsupported',
        `The root AGENTS.md imports ${guideImports.map(path => `@${path}`).join(', ')}, and a file it imports would reach the model without being bound by this probe, so this cell is not measured. To have selftest measure it, write ${guideImports.length === 1 ? 'that import' : 'those imports'} as plain paths in your part of AGENTS.md, run sync, then write fresh probe specifications; otherwise measure it by hand with a candidate and a deliberately broken control.`,
    )
    // Claude removes HTML comments before delivering the guide; the probe reproduces that only for cockpit's own markers.
    if (modelInput && probe.harness.target === 'claudecode' && probe.capability === 'instruction-loading'
        && foreignClaudeComment(selectedEntryBytes(probe) ?? '')) return humanNeeded('native_protocol_unsupported',
        'The root AGENTS.md holds an HTML comment spanning several lines, and this probe reproduces Claude\'s removal of one-line comments only, so this cell is not measured. Put the comment on one line or move it out of AGENTS.md, run sync, then write fresh probe specifications; otherwise measure it by hand with a candidate and a deliberately broken control.',
    )
    // The measured claim is that Claude delivers AGENTS.md through the CLAUDE.md import. The team's
    // own notes beside it travel with the bytes sync read; a file it imports would reach the model unbound.
    const teamImports = probe.teamClaudeGuide === undefined ? [] : probeImports(probe.teamClaudeGuide, root)
    if (modelInput && teamImports.length > 0) return humanNeeded('native_protocol_unsupported',
        `This checkout's own CLAUDE.md, which cockpit leaves as the team wrote it, also imports ${teamImports.map(path => `@${path}`).join(', ')}, and a file it imports would reach the model without being bound by the probe, so this cell is not measured. To have selftest measure it, write ${teamImports.length === 1 ? 'that import' : 'those imports'} as plain paths or move the text into CLAUDE.md or AGENTS.md, run sync, then write fresh probe specifications; otherwise measure it by hand with a candidate and a deliberately broken control.`,
    )
    if (modelInput && probe.sample && nativeSkillBody(selectedEntryBytes(probe) ?? '') === undefined) return humanNeeded('native_protocol_unsupported',
        'The generated skill cannot be loaded by the bounded body-only probe: check frontmatter, direct invocation, dynamic context and agent or hook declarations. It remains unmeasured; do not remove its restrictions to pass selftest.',
    )
    const resolution = await resolveExecutable(BUILTIN_EXECUTABLES[probe.harness.target], env)
    if (resolution.state === 'unavailable') return humanNeeded('executable_missing',
        `${resolution.reason}; install ${harnessName} on a supported host, sign in, and rerun its ${probe.capability} probe`,
    )
    const executable = resolution.value
    if (!await hasExecutableAuthority(adapters, approvedExecutables, probe.harness.name, executable)) {
        return humanNeeded('authentication_required',
            `Provide an operator-approved absolute executable identity for ${harnessName} and rerun its ${probe.capability} probe`,
        )
    }
    if (typeof evidenceRoot !== 'string') return humanNeeded('isolation_unavailable',
        `${PROBE_EVIDENCE_ROOT} could not be created as a plain directory (${evidenceRoot.reason}), so probe controls cannot be kept apart from the checkout; make it a plain directory and rerun the ${harnessName} ${probe.capability} probe`,
    )
    let directory: string
    let controls: Awaited<ReturnType<typeof writeControlPair>>
    try {
        directory = join(evidenceRoot, `selftest-${randomBytes(12).toString('hex')}`)
        await mkdir(directory, { mode: 0o700 })
        controls = await writeControlPair(directory, probe, expectation.guardHookCommand)
    } catch (error) { return { runFailure: `could not write probe controls: ${errorCause(error)}` } }
    if ('probeFailure' in controls) return controls
    const candidatePath = relativeEvidencePath(root, controls.candidate)
    const brokenPath = relativeEvidencePath(root, controls.broken)
    const transcript = join(directory, 'transcript.json')
    const transcriptPath = relativeEvidencePath(root, transcript)
    if (!candidatePath || !brokenPath || !transcriptPath) return { runFailure: `the probe controls under ${directory} do not resolve inside ${root}; make ${PROBE_EVIDENCE_ROOT} a plain directory of this checkout, then rerun selftest` }

    const inputNames = new Map<string, string>([
        [executable.canonicalPath, `the approved ${harnessName} executable`],
        [controls.candidate, 'the candidate probe control'],
        [controls.broken, 'the broken probe control'],
        ...guard && guardHandler ? [
            [join(root, GUARD_LOCAL_PATHS.identity), 'cockpit\'s guard identity, which sync writes,'],
            [join(root, GUARD_LOCAL_PATHS.generatedConfig), 'the configuration sync recorded for the guard,'],
            [guardHandler.configPath, 'the cockpit configuration'],
            [guardHandler.node, 'the Node executable the guard runs,'],
            [guardHandler.module, 'the cockpit module the guard runs,'],
            [join(root, '.cockpit/guards/bash-guard.sh'), 'the generated Bash guard'],
        ] as const : [],
    ])
    const describeInput = (path: string) => `${inputNames.get(path) ?? 'the probe input'} ${path}`
    const deadline = Date.now() + EVIDENCE_EXPIRY_MS
    const invocation = publicCommand(probe.invocation, executable.canonicalPath)
    const versionCommand = publicCommand(probe.versionCommand, executable.canonicalPath)
    const helpCommand = publicCommand(probe.helpCommand, executable.canonicalPath)
    const commonFiles = [consumedExecutable(executable)]
    const probeEnvironment = Object.fromEntries(Object.entries(env).filter(
        (row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0 && !row[1].includes('\0')))
    const controlCwd = (control: string): string => guard ? root : modelInput ? join(directory, control === controls.candidate ? 'candidate' : 'broken') : dirname(control)
    const controlIndex = invocation.indexOf('{control}')
    if (!native && controlIndex < 0) return { probeFailure: `the probe invocation for ${harnessName} ${probe.capability} has no {control} argument, so neither control would reach the tool; add {control} where the tool takes the file, then approve the probe specifications again` }
    const candidateCommand = publicCommand(invocation, executable.canonicalPath, candidatePath)
    const brokenCommand = publicCommand(invocation, executable.canonicalPath, brokenPath)
    const modelEndpoints = { candidate: '', broken: '' }
    const modelCommand = (command: readonly [string, ...string[]], cwd: string, endpoint: string): [string, ...string[]] => {
        const url = new URL(endpoint)
        return command.map(value => value.replace('{model-endpoint}', endpoint).replace('{native-settings}', join(cwd, 'native-settings.json'))
            .replaceAll('{loopback-port}', url.port).replaceAll('{nonce}', url.pathname.slice(1))) as [string, ...string[]]
    }
    const createStep = (role: string, command: readonly [string, ...string[]], control?: typeof controls.candidate, endpoint?: string): ExecutionStep | undefined => {
        const execution = executionCommand(command, root, control ? relativeEvidencePath(root, control) : undefined)
        const files = [...commonFiles]
        if (control && (!native || guard)) files.push({ path: control, sha256: control === controls.candidate ? controls.candidateSha256 : controls.brokenSha256,
            maxBytes: MAX_CONTROL_BYTES, argvIndexes: [controlIndex], executable: false })
        const cwd = native && control ? controlCwd(control) : root
        const checks: FilesystemCheck[] = native && !guard && control ? [{ path: control, expected: 'file',
            sha256: control === controls.candidate ? controls.candidateSha256 : controls.brokenSha256, maxBytes: MAX_CONTROL_BYTES },
            { path: join(cwd, 'AGENTS.override.md'), expected: 'absent' }] : []
        if (guard && control) checks.push(...guardRuntime!.map(file => ({ ...file, expected: 'file' as const })))
        if (modelInput && control && probe.capability === 'instruction-loading') checks.push({ path: join(cwd, 'CLAUDE.md'), expected: 'file',
            sha256: expectation.nativeSourceSha256?.['CLAUDE.md'], maxBytes: MAX_CONTROL_BYTES })
        if (modelInput && !guard && control && probe.harness.target === 'claudecode') files.push({ path: join(cwd, 'native-settings.json'),
            sha256: sha256Hex(nativeInputSettings(cwd)), maxBytes: MAX_CONTROL_BYTES, argvIndexes: [invocation.indexOf('{native-settings}')], executable: false })
        const environment = modelInput ? { PATH: probeEnvironment.PATH ?? '', HOME: join(directory, 'home'),
            CODEX_HOME: join(directory, 'home', '.codex'), CLAUDE_CONFIG_DIR: join(directory, 'home', '.claude'),
            DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            ...(endpoint && probe.harness.target === 'claudecode' ? { ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: 'synthetic-local-not-a-credential' } : {}),
        } : probeEnvironment
        const vector = endpoint ? modelCommand(execution, cwd, endpoint) : execution
        return step(`surface-selftest-${randomBytes(8).toString('hex')}-${role}`, cwd, vector, executable.invocationPath, files, deadline,
            { harness: harnessName, capability: probe.capability, role }, environment, checks, native ? NATIVE_SELFTEST_STREAM_BYTES : STREAM_BYTES)
    }
    const version = await run(adapters, createStep('version', versionCommand), 'version')
    const help = await run(adapters, createStep('help', helpCommand), 'help')
    const stopped = runStop('version', version, describeInput) ?? runStop('help', help, describeInput)
    if (stopped) return stopped
    if (modelInput && 'outcome' in help && help.outcome.kind === 'complete'
        && !(guard ? /--settings\b/ : probe.harness.target === 'claudecode' ? /--print\b/ : /\bexec\b/).test(help.outcome.stdout.toString('utf8'))) {
        return humanNeeded('native_protocol_unsupported',
            `${harnessName} does not advertise the command required by this native input protocol. Update the harness and regenerate the probe specifications; no capability was measured.`)
    }
    const modelInputs: { candidate: string; broken: string } = { candidate: '[]', broken: '[]' }
    const guardReceipts: { candidate: readonly string[]; broken: readonly string[] } = { candidate: [], broken: [] }
    let captureFailure: string | undefined
    const runControl = async (role: 'candidate' | 'broken') => {
        const command = role === 'candidate' ? candidateCommand : brokenCommand
        const control = role === 'candidate' ? controls.candidate : controls.broken
        if (!modelInput) return run(adapters, createStep(role, command, control), role)
        const model = await startSelftestModel(probe.harness.target as 'claudecode' | 'codexcli', guard ? probe.guardHost : undefined)
        try {
            modelEndpoints[role] = model.endpoint
            const result = await run(adapters, createStep(role, command, control, model.endpoint), role)
            const stop = runStop(role, result, describeInput)
            if (stop) return stop
            captureFailure ??= model.failure()
            if (captureFailure) return { probeFailure: captureFailure }
            const captured = boundedStream(Buffer.from(JSON.stringify(model.requests())), NATIVE_SELFTEST_STREAM_BYTES)
            if (captured === undefined) { captureFailure = 'native model input could not be captured within its redaction and size bounds'; return { probeFailure: captureFailure } }
            modelInputs[role] = captured
            guardReceipts[role] = model.guard?.receipts() ?? []
            return result
        } finally { await model.close() }
    }
    let broken: Awaited<ReturnType<typeof run>>, candidate: Awaited<ReturnType<typeof run>>
    try {
        broken = await runControl('broken')
        const stop = runStop('broken', broken, describeInput)
        if (stop) return stop
        candidate = await runControl('candidate')
    } catch (error) { return { probeFailure: `native input capture failed: ${errorCause(error)}` } }
    const stop = runStop('candidate', candidate, describeInput)
    if (stop) return stop
    if (captureFailure) return { probeFailure: captureFailure }
    if (!('outcome' in version)) return version
    if (!('outcome' in help)) return help
    if (!('outcome' in broken)) return broken
    if (!('outcome' in candidate)) return candidate
    if ([version, help, broken, candidate].some((row) => (!native || row.outcome.kind !== 'complete') && authenticationRequired(row.outcome))) {
        return humanNeeded('authentication_required',
            `Authenticate ${harnessName} and rerun its ${probe.capability} probe`,
        )
    }
    for (const [flag, { outcome }] of [['--version', version], ['--help', help]] as const) if (outcome.kind === 'refusal') {
        return { probeFailure: `${harnessName} ${flag} did not complete (${outcome.code}, exit ${outcome.execution.exitCode}, signal ${outcome.execution.signal}); check that the approved executable runs from a terminal, then rerun selftest` }
    }
    const brokenOutput = `${broken.outcome.stdout.toString('utf8')}\n${broken.outcome.stderr.toString('utf8')}`
    if (!native && (broken.outcome.kind !== 'refusal' || !exactLine(brokenOutput, probe.brokenCode))) return { probeFailure: `${harnessName} did not reject the broken control with the legacy exact diagnostic and process status. Rewrite the probe specifications to select a supported native protocol; malformed Markdown and Claude print-mode settings do not provide syntax rejection.` }
    const candidateOutput = `${candidate.outcome.stdout.toString('utf8')}\n${candidate.outcome.stderr.toString('utf8')}`
    let verdict: SelftestEvidenceRecord['verdict']
    let candidateResult: SelftestProbeEvent['result']
    let candidateCode: string
    if (native) {
        if (candidate.outcome.kind !== 'complete' || broken.outcome.kind !== 'complete') {
            const failures = [broken, candidate].map((row, index) => `${index === 0 ? 'broken' : 'candidate'}: ${row.outcome.kind === 'refusal' ? row.outcome.code : 'complete'} (exit ${row.outcome.execution.exitCode}, signal ${row.outcome.execution.signal})`)
            return { probeFailure: `native prompt-input did not complete both controls: ${failures.join('; ')}; inspect tool availability, output bounds and project trust without bypassing policy` }
        }
        const problem = guard ? validateNativeGuardPair({ host: probe.guardHost!, guardCommand: expectation.guardHookCommand, brokenCommand: controls.brokenHookCommand!,
            candidateBytes: selectedEntryBytes(probe)!, brokenBytes: controls.brokenBytes,
            observations: {
                candidate: { endpoint: modelEndpoints.candidate, input: modelInputs.candidate, receipts: guardReceipts.candidate },
                broken: { endpoint: modelEndpoints.broken, input: modelInputs.broken, receipts: guardReceipts.broken },
            }, candidateStdout: candidate.outcome.stdout.toString('utf8'), brokenStdout: broken.outcome.stdout.toString('utf8') })
            : modelInput ? validateNativeModelInputPair({ target: probe.harness.target as 'claudecode' | 'codexcli',
            skill: probe.sample?.skill, candidateInput: modelInputs.candidate, brokenInput: modelInputs.broken,
            candidatePath: controls.candidate, brokenPath: controls.broken, candidateBytes: selectedEntryBytes(probe)!, brokenBytes: controls.brokenBytes,
            brokenStdout: broken.outcome.stdout.toString('utf8'), brokenStderr: broken.outcome.stderr.toString('utf8') })
            : validateNativeInstructionPair(candidate.outcome.stdout.toString('utf8'), broken.outcome.stdout.toString('utf8'),
            dirname(controls.candidate), dirname(controls.broken), selectedEntryBytes(probe)!,
            controls.brokenBytes)
        if (problem && guard) return { probeFailure: guardInterference(probe, expectation.guardHookCommand,
            { broken: broken.outcome.stdout.toString('utf8'), candidate: candidate.outcome.stdout.toString('utf8') }) ?? problem }
        if (problem) return { probeFailure: problem }
        verdict = guard ? 'enforced' : 'instructed'; candidateResult = guard ? 'refused' : 'accepted'; candidateCode = probe.candidateCode
    } else if (candidate.outcome.kind === 'complete' && exactLine(candidateOutput, probe.candidateCode)) {
        verdict = 'instructed'; candidateResult = 'accepted'; candidateCode = probe.candidateCode
    } else if (candidate.outcome.kind === 'refusal' && probe.capability === 'guard-firing' && exactLine(candidateOutput, probe.candidateCode)) {
        verdict = 'enforced'; candidateResult = 'refused'; candidateCode = probe.candidateCode
    } else if (exactLine(candidateOutput, probe.unavailableCode)) {
        verdict = 'unavailable'; candidateResult = candidate.outcome.kind === 'complete' ? 'allowed' : 'unavailable'; candidateCode = probe.unavailableCode
    } else return { probeFailure: `${harnessName} printed neither ${probe.candidateCode} nor ${probe.unavailableCode} on a line of its own for the candidate control (exit ${candidate.outcome.execution.exitCode}); check those codes in the probe specifications against what the tool prints` }
    const startedAt = version.startedAt
    const finishedAt = candidate.finishedAt
    const expiresAt = new Date(Math.min(Date.parse(startedAt) + EVIDENCE_EXPIRY_MS, deadline)).toISOString()
    const events = {
        version: event(versionCommand, '.', version.outcome, 'completed', 'VERSION_OK'),
        help: event(helpCommand, '.', help.outcome, 'completed', 'HELP_OK'),
        brokenControl: event(modelInput ? modelCommand(brokenCommand, controlCwd(controls.broken), modelEndpoints.broken) : brokenCommand,
            native ? relative(root, controlCwd(controls.broken)) || '.' : '.', broken.outcome, guard ? 'allowed' : native ? 'accepted' : 'rejected', probe.brokenCode, native ? NATIVE_SELFTEST_STREAM_BYTES : STREAM_BYTES),
        candidateControl: event(modelInput ? modelCommand(candidateCommand, controlCwd(controls.candidate), modelEndpoints.candidate) : candidateCommand,
            native ? relative(root, controlCwd(controls.candidate)) || '.' : '.', candidate.outcome, candidateResult, candidateCode, native ? NATIVE_SELFTEST_STREAM_BYTES : STREAM_BYTES),
    }
    if (!events.version || !events.help || !events.brokenControl || !events.candidateControl) return { probeFailure: `a ${harnessName} output stream is not UTF-8 text, holds a credential-shaped value that cannot be redacted safely, or exceeds its evidence bound, so it cannot be kept as evidence; rerun selftest, and if it repeats, run the probe's commands by hand to see which output it is` }
    if (native && !modelInput && validateNativeInstructionPair(events.candidateControl.stdout, events.brokenControl.stdout,
        dirname(controls.candidate), dirname(controls.broken), selectedEntryBytes(probe)!, controls.brokenBytes)) {
        return { probeFailure: 'the generated AGENTS.md holds credential-shaped text such as api_key=<value>, which evidence redacts, so the stored stream cannot match the source. Reword that text in the guide it came from, run sync, then rerun selftest' }
    }
    const versionText = `${events.version.stdout} ${events.version.stderr}`.trim()
    const versionValue = native ? (probe.harness.target === 'claudecode' ? /^(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?) \(Claude Code\)$/
        : /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/).exec(events.version.stdout.trim())?.[1]
        : versionText.split(/\s+/).find(Boolean)
    if (!versionValue || Buffer.byteLength(versionValue) > 256) return { probeFailure: `${harnessName} --version printed no version cockpit recognises, so the evidence could not name the version it measured; update ${harnessName}, then rerun selftest` }
    const record: SelftestEvidenceRecord = {
        ...(native ? { protocol: probe.protocol as SelftestEvidenceRecord['protocol'] } : {}),
        ...(modelInput ? { modelInputs, modelEndpoints } : {}),
        ...(guard ? { guardProbe: { host: probe.guardHost!, brokenCommand: controls.brokenHookCommand!, receipts: guardReceipts } } : {}),
        kind: 'evidence', harness: probe.harness, capability: probe.capability,
        generatedManifestSha256: expectation.generatedManifestSha256, verdict, version: versionValue, measuredOn: startedAt.slice(0, 10),
        runId: `selftest-${randomBytes(16).toString('hex')}`, startedAt, finishedAt, expiresAt,
        candidatePath, brokenPath, transcriptPath, candidateSha256: controls.candidateSha256,
        brokenSha256: controls.brokenSha256, transcriptSha256: '', invocation: [...invocation],
        versionCommand: [...versionCommand], helpCommand: [...helpCommand],
        candidateCode, brokenCode: probe.brokenCode, sample: probe.sample,
        authority: { kind: 'native-executable', name: probe.harness.name, executable: executable.canonicalPath },
        events: events as SelftestEvidenceRecord['events'],
    }
    const { transcriptSha256: _transcriptSha256, ...transcriptRecord } = record
    void _transcriptSha256
    const transcriptBytes = JSON.stringify(transcriptRecord)
    await writeFile(transcript, transcriptBytes, { flag: 'wx', mode: 0o600 })
    return { ...record, transcriptSha256: sha256Hex(transcriptBytes) }
}

// A failure can quote several hooks' refusals; the record holds what fits its bound.
function boundedOperatorAction(text: string): string {
    const clean = text.replaceAll('\0', '')
    if (Buffer.byteLength(clean) <= 4_096) return clean
    return `${Buffer.from(clean).subarray(0, 4_088).toString('utf8').replace(/\uFFFD$/, '')}...`
}

const HOOK_LINE_CHARACTERS = 160

// The guard probe hands Claude Code the generated settings whole, so every hook registered there can
// run under it. The bytes are the generated manifest's, which the approved file's digest binds.
function teamHookRegistrations(bytes: string | undefined, cockpitCommands: readonly string[]): readonly string[] {
    let hooks: unknown
    // Unparseable settings fail the guard probe before any step runs, so no hook of theirs runs either.
    try { hooks = bytes === undefined ? undefined : JSON.parse(bytes)?.hooks } catch { return [] }
    if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return []
    return Object.entries(hooks).flatMap(([event, groups]: [string, unknown]) => (Array.isArray(groups) ? groups : [])
        .flatMap((group: { matcher?: unknown; hooks?: unknown }) => (Array.isArray(group?.hooks) ? group.hooks : [])
            .flatMap((hook: { type?: unknown; command?: unknown }) => {
                if (typeof hook?.command === 'string' && cockpitCommands.includes(hook.command)) return []
                const runs = typeof hook?.command === 'string' ? hook.command.replace(/\s+/g, ' ').trim() : `a ${String(hook?.type)} hook`
                const line = `${event}${group.matcher === undefined ? '' : ` matcher ${JSON.stringify(group.matcher)}`} runs ${runs}`
                return [line.length > HOOK_LINE_CHARACTERS ? `${line.slice(0, HOOK_LINE_CHARACTERS - 3)}...` : line]
            })))
}

export async function runSurfaceSelftestApplication(
    input: SurfaceSelftestCommandInput,
    adapters: SurfaceSelftestCommandAdapters = defaultAdapters,
): Promise<SurfaceSelftestCommandOutcome> {
    const capturedInput = commandInput(input)
    if (!capturedInput) return refusal('SELFTEST_SOURCE_INVALID', 'selftest command input must contain only bounded own data')
    const application = generatedApplicationProjection(capturedInput.application)
    if (!application || application !== capturedInput.application) return refusal('SELFTEST_SOURCE_INVALID', 'generated application authority was not issued by its producer')
    const plan = planSurfaceSelftest(application.surfaceSelftest, capturedInput.specifications)
    if (plan.kind === 'refusal') return refusal(plan.code, plan.reason)
    const root = normalize(capturedInput.root)
    if (!isAbsolute(root) || root !== capturedInput.root || basename(root).length === 0) return refusal('SELFTEST_SOURCE_INVALID', 'selftest root must be a canonical absolute directory')
    const evidenceRoot = await ensureEvidenceDirectory(root)
    const records: SelftestEvidenceBundle['records'][number][] = []
    const approvedExecutables: OperatorExecutableIdentities = new Map()
    // Every probe with a supported protocol produced evidence. The Claude guard has a protocol even when
    // no vendor host is declared yet; cells without one, and custom cells, stay outside.
    let measurementComplete = true
    for (const probe of plan.probes) {
        const supported = probe.protocol !== 'native-unsupported/v1' || probe.harness.target === 'claudecode' && probe.capability === 'guard-firing'
        const record = await runEvidenceProbe(
            root, evidenceRoot, plan.expectation, probe, capturedInput.env, adapters, approvedExecutables, generatedSelftestGuardRuntime(application, root),
            generatedSelftestGuardHandler(application, root),
        )
        if ('runFailure' in record) return refusal('SELFTEST_EXECUTION_INVALID', `probe execution could not establish ${probe.capability} for ${probe.harness.name}: ${record.runFailure}`)
        if (supported && !('kind' in record && record.kind === 'evidence')) measurementComplete = false
        if ('probeFailure' in record) {
            const failed = surfaceSelftestHumanNeeded(plan.expectation, probe.cell, 'probe_failed', new Date().toISOString(), boundedOperatorAction(record.probeFailure))
            if (!failed) return refusal('SELFTEST_EXECUTION_INVALID', `could not record ${surfaceSelftestCellLabel(probe.cell)} as failed: ${record.probeFailure}`)
            records.push(failed)
            continue
        }
        records.push(record)
    }
    for (const cell of plan.unprobeable) {
        const record = surfaceSelftestHumanNeeded(plan.expectation, cell, 'enforcement_probe_required', new Date().toISOString(),
            `${UNPROBEABLE_REASON}; ${UNPROBEABLE_ACTION} for ${surfaceSelftestCellLabel(cell)}`)
        if (!record) return refusal('SELFTEST_EXECUTION_INVALID', `could not record ${surfaceSelftestCellLabel(cell)} as human_needed`)
        records.push(record)
    }
    const reviews = surfaceSelftestReviews(plan.expectation, [])
    if (!reviews) return refusal('SELFTEST_SOURCE_INVALID', 'skill review inventory could not be constructed')
    const bundle: SelftestEvidenceBundle = {
        schema: 'cockpit-harness-selftest/v1', generatedManifestSha256: plan.expectation.generatedManifestSha256,
        records, skillInventory: plan.expectation.shippedSkills, skillReviews: reviews,
    }
    const testOnlyExecutableIdentities = process.env.NODE_ENV === 'test'
        ? adapters.testOnlyExecutableIdentities : undefined
    const evidence = validateSelftestEvidenceBundle(bundle, plan.expectation, root, {
        operatorExecutableIdentities: approvedExecutables,
        testOnlyExecutableIdentities,
    })
    if (evidence.errors.length > 0) return refusal('SELFTEST_EXECUTION_INVALID', evidence.errors.join('; '))
    return records.some(row => row.kind === 'human_needed' && row.reason === 'probe_failed')
        ? { kind: 'incomplete', status: 2, root, bundle, evidence, measurementComplete }
        : { kind: 'complete', status: 0, root, bundle, evidence, measurementComplete }
}

const GUARD_IDENTITY_PARTS: readonly Readonly<[string, readonly (keyof GuardHandlerIdentity)[]]>[] = [
    ['the Node executable', ['node', 'nodeSha256', 'nodeFingerprint']],
    ['the cockpit module', ['module', 'moduleSha256']],
    ['the cockpit directory', ['root', 'rootInode']],
    ['cockpit.toml', ['configPath', 'configSha256', 'configInode']],
]

// sync records the Node it ran under, and the guard hook runs that Node by path. The guard probe binds
// the identity this process would write, so under a different Node (a version manager's shell, say)
// the executor refused the probe's first guard step, after every approval, naming no input. Compare
// the same digest the executor checks before asking anything; the parsed file only names the difference.
async function guardIdentityMismatch(
    application: GeneratedApplicationProjection,
    root: string,
    configPath: string,
    rerunUnderNode: SurfaceSelftestCommandAdapters['rerunUnderNode'],
): Promise<SurfaceSelftestCommandOutcome | undefined> {
    const current = generatedSelftestGuardHandler(application, root)
    const identityPath = join(root, GUARD_LOCAL_PATHS.identity)
    const bound = generatedSelftestGuardRuntime(application, root)?.find(file => file.path === identityPath)
    // Without a bound guard runtime the guard probe refuses on its own and says to run sync.
    if (!current || !bound) return undefined
    let bytes: Buffer | undefined
    try {
        const read = await readBoundedInput(identityPath)
        if (read.kind === 'complete') bytes = read.bytes
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) return refusal('SELFTEST_SOURCE_INVALID', `${identityPath} could not be read: ${errorCause(error)}`)
    }
    if (bytes !== undefined && sha256Hex(bytes) === bound.sha256) return undefined
    const installed = bytes === undefined ? undefined : parseGuardLocalIdentity(bytes.toString('utf8'))
    const sync = cockpitCommand('sync', { config: configPath })
    const selftest = cockpitCommand('selftest', { config: configPath, args: '--interactive' })
    // The same path with other bytes is an in-place upgrade: no Node runs what sync recorded any more.
    if (installed && installed.node === current.node && installed.nodeSha256 !== current.nodeSha256) return {
        kind: 'refusal', status: 2, code: 'SELFTEST_GUARD_IDENTITY_MISMATCH',
        reason: `the Node at ${current.node} changed since sync recorded it (sha256 ${installed.nodeSha256}, now ${current.nodeSha256}); until sync runs again the guard hook holds ${GUARD_HELD_CALLS}, and the guard-firing probe cannot run, so nothing was run or approved`,
        fix: `run ${sync} under this Node, then rerun ${selftest}`,
    }
    if (installed && installed.node !== current.node) {
        const reason = `sync installed the guard for the Node at ${installed.node}, but this selftest runs under the Node at ${current.node}; the guard hook keeps running the Node sync recorded, and the guard-firing probe can measure only the guard this process would install, so nothing was run or approved`
        if (!rerunUnderNode) return {
            kind: 'refusal', status: 2, code: 'SELFTEST_GUARD_IDENTITY_MISMATCH', reason,
            fix: `run selftest with the Node the guard was installed for: ${formatShellCommand([installed.node])} ${selftest}; or run ${sync} under this Node first, which makes the guard hook run it, then rerun ${selftest}`,
        }
        // Run only the exact Node sync hashed: a path that now holds other bytes, or none, is not the guard's Node.
        const node = await resolveExecutablePath(installed.node)
        const unverified = node.state !== 'available' ? node.reason
            : node.value.canonicalPath !== installed.node ? `it now resolves to ${node.value.canonicalPath}`
            : node.value.sha256 !== installed.nodeSha256 ? `its sha256 is ${node.value.sha256}, not the ${installed.nodeSha256} sync recorded` : undefined
        if (unverified !== undefined || node.state !== 'available') return {
            kind: 'refusal', status: 2, code: 'SELFTEST_GUARD_IDENTITY_MISMATCH',
            reason: `${reason}; selftest did not rerun under the Node at ${installed.node} because ${unverified}`,
            fix: `run ${sync} under this Node, which makes the guard hook run it, then rerun ${selftest}`,
        }
        const rerun = await rerunUnderNode(node.value)
        if (rerun.kind === 'refusal') return rerun.code === ENVIRONMENT_CODES.EXECUTION_ABORTED ? { kind: 'rerun', status: 130 }
            : refusal('SELFTEST_EXECUTION_INVALID', `selftest could not rerun under the Node at ${installed.node}: ${rerun.code}`)
        // A signal leaves no exit code, which must not read as success.
        const signalNumber = rerun.signal ? osConstants.signals[rerun.signal] : undefined
        return signalNumber === undefined ? { kind: 'rerun', status: rerun.exitCode } : { kind: 'rerun', status: 128 + signalNumber, signal: rerun.signal! }
    }
    const differing = installed ? GUARD_IDENTITY_PARTS.filter(([, keys]) => keys.some(key => installed[key] !== current[key])).map(([name]) => name) : []
    return {
        kind: 'refusal', status: 2, code: 'SELFTEST_GUARD_IDENTITY_MISMATCH',
        reason: installed
            ? `${identityPath} differs from the guard identity this selftest would install${differing.length > 0 ? ` in ${differing.join(', ')}` : ''}, so the guard-firing probe could not run; nothing was run or approved`
            : `${identityPath} is missing or not a current guard identity, so the guard-firing probe could not run; nothing was run or approved`,
        fix: `run ${sync} with this cockpit, then rerun ${selftest}`,
    }
}

export async function runConfiguredSurfaceSelftestApplication(
    input: ConfiguredSurfaceSelftestCommandInput,
    adapters: SurfaceSelftestCommandAdapters = defaultAdapters,
): Promise<SurfaceSelftestCommandOutcome> {
    const capturedInput = configuredCommandInput(input)
    if (!capturedInput) return refusal('SELFTEST_SOURCE_INVALID', 'configured selftest input must contain only bounded own data')
    let configPath: string
    try { configPath = await realpath(resolve(capturedInput.configPath)) } catch (error) {
        return refusal('SELFTEST_SOURCE_INVALID', `configured selftest source could not be resolved: ${errorCause(error)}`)
    }
    const checked = await checkGeneratedEnvironment({ configPath })
    if (checked.kind !== 'complete') {
        const reason = checked.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('; ')
        return refusal('SELFTEST_SOURCE_INVALID', reason || 'generated environment check refused configured selftest source')
    }
    const requestedArtifactPath = resolve(capturedInput.probeSpecificationsPath)
    if (!isAbsolute(requestedArtifactPath) || normalize(requestedArtifactPath) !== requestedArtifactPath) {
        return refusal('SELFTEST_SOURCE_INVALID', 'probe specification artifact path must resolve to a canonical absolute path')
    }
    let artifactPath: string
    try { artifactPath = await realpath(requestedArtifactPath) } catch (error) {
        return probeSpecificationsRefusal(`probe specification file ${requestedArtifactPath} is missing or unreadable: ${errorCause(error)}`)
    }
    const bytes = await readProbeSpecificationsArtifact(artifactPath)
    if (typeof bytes !== 'string') return probeSpecificationsRefusal(`probe specification file ${artifactPath} is missing, unreadable, not a regular file or larger than ${MAX_PROBE_SPECIFICATIONS_BYTES} bytes${causeSuffix(bytes?.cause)}`)
    const artifact = probeSpecificationsArtifact(
        bytes,
        checked.result.application.sourceSha256,
        checked.result.application.surfaceSelftest.manifestSha256,
    )
    if (artifact.kind === 'malformed') {
        return probeSpecificationsRefusal(`probe specification file ${artifactPath} is not ${PROBE_SPECIFICATIONS_SCHEMA} JSON with exactly schema, sourceSha256, generatedManifestSha256 and specifications${causeSuffix(artifact.cause)}`)
    }
    if (artifact.kind === 'stale') {
        return {
            kind: 'refusal', status: 2, code: 'SELFTEST_SOURCE_INVALID',
            reason: `probe specification file ${artifactPath} was written for a different cockpit.toml or generated manifest`,
            fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config <your cockpit.toml> --interactive, which writes fresh probe specifications itself; to keep a file under review instead, write one that keeps the rows you filled for unchanged cells with ./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config <your cockpit.toml> --write-probe-specifications <new file> --probe-specifications <this file> (add --replace to write over an existing file), review it, then pass the new file to --probe-specifications',
        }
    }
    const unfilled = unfilledSurfaceSelftestSpecifications(artifact.specifications)
    if (unfilled.length > 0) {
        return {
            kind: 'refusal', status: 2, code: 'SELFTEST_SOURCE_INVALID',
            reason: `probe specification file ${artifactPath} still has ${unfilled.length} row(s) with fields only a person can supply: ${unfilled.slice(0, 5).join('; ')}${unfilled.length > 5 ? `; and ${unfilled.length - 5} more` : ''}`,
            fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config <your cockpit.toml> --interactive, which writes fresh probe specifications whose rows need no filling, or replace each null in the listed rows with the probe for that tool',
        }
    }
    const specifications = artifact.specifications as readonly SelftestProbeSpecification[]
    const plan = planSurfaceSelftest(checked.result.application.surfaceSelftest, specifications)
    if (plan.kind === 'refusal') return refusal(plan.code, plan.reason)
    const artifactSha256 = sha256Hex(bytes)
    const guardProbe = plan.probes.find(probe => probe.protocol === 'claude-guard-loopback/v1')
    if (guardProbe) {
        const mismatch = await guardIdentityMismatch(checked.result.application, dirname(configPath), configPath, adapters.rerunUnderNode)
        if (mismatch) return mismatch
    }
    const guardProbeTeamHooks = guardProbe ? teamHookRegistrations(selectedEntryBytes(guardProbe),
        checked.result.application.surfaceSelftest.cockpitHookCommands ?? []) : []
    const candidate: SurfaceSelftestProbeSpecificationsCandidate = {
        canonicalPath: artifactPath,
        sha256: artifactSha256,
        sourceSha256: checked.result.application.sourceSha256,
        generatedManifestSha256: checked.result.application.surfaceSelftest.manifestSha256,
        commandVectors: plan.probes.map((probe) => ({
            harness: probe.harness.name,
            capability: probe.capability,
            ...(probe.protocol ? { protocol: probe.protocol, executes: probe.protocol !== 'native-unsupported/v1' } : {}),
            ...(probe.guardHost ? { guardHost: probe.guardHost } : {}),
            skill: probe.sample?.skill ?? null,
            invocation: [...probe.invocation] as readonly [string, ...string[]],
            versionCommand: [...probe.versionCommand] as readonly [string, ...string[]],
            helpCommand: [...probe.helpCommand] as readonly [string, ...string[]],
        })),
        ...guardProbeTeamHooks.length > 0 ? { guardProbeTeamHooks } : {},
    }
    const confirmation = await adapters.requestProbeSpecificationsApproval?.(candidate)
    if (confirmation !== artifactSha256) {
        // No `fix` field: the diagnostic index would print it as the remedy for every
        // SELFTEST_EXECUTION_INVALID, including probes that ran and failed.
        return refusal(
            'SELFTEST_EXECUTION_INVALID',
            'probe specification artifact requires independent approval of its exact digest and command vectors; run selftest with --interactive at a terminal outside CI and confirm the displayed artifact and runnable commands',
        )
    }
    const changedReview = new Error('selftest artifact, configuration or generated manifest changed after review; prepare a fresh preview and review it before retrying')
    const revalidate = async () => {
        const reviewedBytes = await readProbeSpecificationsArtifact(artifactPath)
        const reviewedSource = await checkGeneratedEnvironment({ configPath })
        if (reviewedBytes !== bytes || reviewedSource.kind !== 'complete'
            || reviewedSource.result.application.sourceSha256 !== checked.result.application.sourceSha256
            || reviewedSource.result.application.surfaceSelftest.manifestSha256 !== checked.result.application.surfaceSelftest.manifestSha256) {
            throw changedReview
        }
    }
    try {
        await revalidate()
        return await runSurfaceSelftestApplication({
            application: checked.result.application,
            root: dirname(configPath),
            specifications,
            env: capturedInput.env,
        }, { ...adapters, ...(adapters.requestExecutableApproval ? {
            requestExecutableApproval: async (executable: SurfaceSelftestExecutableCandidate) => {
                const approval = await adapters.requestExecutableApproval!(executable)
                // The person's second review can outlive the inputs authenticated by the first.
                await revalidate()
                return approval
            },
        } : {}) })
    } catch (error) {
        if (error === changedReview) return refusal('SELFTEST_SOURCE_INVALID', changedReview.message)
        throw error
    }
}

export interface SurfaceSelftestHandlerInput extends Omit<ConfiguredSurfaceSelftestCommandInput, 'probeSpecificationsPath'> {
    /** Absent for the one-command run, which writes fresh specifications itself for the person to approve. */
    readonly probeSpecificationsPath?: string
    readonly requestExecutableApproval?: SurfaceSelftestCommandAdapters['requestExecutableApproval']
    readonly requestProbeSpecificationsApproval?: SurfaceSelftestCommandAdapters['requestProbeSpecificationsApproval']
    readonly rerunUnderNode?: SurfaceSelftestCommandAdapters['rerunUnderNode']
}

export interface SurfaceSelftestDispatchOutcome {
    readonly artifact?: string | null
    readonly destination?: string | null
    /** The CLI may write `artifact` over an existing `destination`. */
    readonly replace?: boolean
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
}

export interface SelftestOperatorIo {
    readonly stderr: Pick<NodeJS.WriteStream, 'write'>
    readonly stdin?: NodeJS.ReadStream
    readonly confirmSelftestExecutable?: SurfaceSelftestCommandAdapters['requestExecutableApproval']
    readonly confirmSelftestProbeSpecifications?: SurfaceSelftestCommandAdapters['requestProbeSpecificationsApproval']
}

export interface SelftestOperatorOptions {
    readonly interactive: boolean
    readonly json: boolean
    readonly ci: string | undefined
    readonly rerunUnderNode?: SurfaceSelftestCommandAdapters['rerunUnderNode']
}

/**
 * Writes the probe-specification file for the current cockpit.toml and generated manifest. The CLI
 * creates `destination` and refuses an existing path unless the person passed --replace, so a
 * filled-in file is never overwritten by accident.
 */
async function writeConfiguredSurfaceSelftestSpecifications(
    input: SurfaceSelftestDraftInput,
): Promise<SurfaceSelftestDispatchOutcome> {
    const refused = (message: string): SurfaceSelftestDispatchOutcome => ({
        status: 2, diagnostics: [{ severity: 'error', code: 'SELFTEST_SOURCE_INVALID', message }], result: null,
    })
    let configPath: string
    try { configPath = await realpath(resolve(input.configPath)) } catch (error) {
        return refused(`configured selftest source could not be resolved: ${errorCause(error)}`)
    }
    const checked = await checkGeneratedEnvironment({ configPath })
    if (checked.kind !== 'complete') {
        return refused(checked.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('; ')
            || 'generated environment check refused configured selftest source')
    }
    let previous: readonly unknown[] = []
    let previousPath: string | undefined
    if (input.previousProbeSpecificationsPath !== undefined) {
        try { previousPath = await realpath(resolve(input.previousProbeSpecificationsPath)) } catch (error) {
            return refused(`earlier probe specification file ${resolve(input.previousProbeSpecificationsPath)} is missing or unreadable: ${errorCause(error)}`)
        }
        const bytes = await readProbeSpecificationsArtifact(previousPath)
        if (typeof bytes !== 'string') return refused(`earlier probe specification file ${previousPath} is unreadable, not a regular file or larger than ${MAX_PROBE_SPECIFICATIONS_BYTES} bytes${causeSuffix(bytes?.cause)}`)
        // A stale file is the expected input: the digests changed, the rows may not have.
        const earlier = probeSpecificationsArtifact(bytes, checked.result.application.sourceSha256,
            checked.result.application.surfaceSelftest.manifestSha256)
        if (earlier.kind === 'malformed') {
            return refused(`earlier probe specification file ${previousPath} is not ${PROBE_SPECIFICATIONS_SCHEMA} JSON with exactly schema, sourceSha256, generatedManifestSha256 and specifications${causeSuffix(earlier.cause)}`)
        }
        previous = earlier.specifications
    }
    const draft = draftSurfaceSelftestSpecifications(checked.result.application.surfaceSelftest, previous)
    if (!draft) return refused('generated selftest projection is invalid')
    const { specifications, unprobeable, carried } = draft
    const destination = resolve(input.writeProbeSpecificationsPath)
    return {
        status: 0,
        diagnostics: unprobeable.map((cell) => ({
            severity: 'warning' as const,
            code: 'SELFTEST_CUSTOM_PROBE_UNSUPPORTED' satisfies typeof ENVIRONMENT_CODES.SELFTEST_CUSTOM_PROBE_UNSUPPORTED,
            message: `no row written for ${surfaceSelftestCellLabel(cell)}: ${UNPROBEABLE_REASON}, so selftest records this cell human_needed with enforcement_probe_required`,
            target: surfaceSelftestCellLabel(cell),
            fix: 'measure the custom harness capability by hand with a candidate and a deliberately broken control, then record what you saw as its state and measured_on in cockpit.toml (enforced needs an evidence file); do not add a row for it',
        })),
        ...input.replace ? { replace: true } : {},
        artifact: `${JSON.stringify({
            schema: PROBE_SPECIFICATIONS_SCHEMA,
            sourceSha256: checked.result.application.sourceSha256,
            generatedManifestSha256: checked.result.application.surfaceSelftest.manifestSha256,
            specifications,
        }, null, 2)}\n`,
        destination,
        result: {
            probeSpecifications: destination,
            rows: specifications.length,
            fromGeneratedManifest: 'harness, capability, sample.skill and unavailableCode for every cell that needs evidence',
            fromCockpit: 'closed native protocols and command vectors; unsupported native rows execute nothing. Review the runnable commands when you approve the file',
            ...(previousPath === undefined ? {} : {
                carriedForward: `${carried} of ${specifications.length} row(s) kept unchanged from ${previousPath}; every other row is new or changed, or was not complete there`,
            }),
            fromYou: 'review the closed native protocol and commands; unsupported native cells remain human_needed. Previously filled legacy exact-code probes are preserved unchanged',
            then: cockpitCommand('selftest', { config: configPath, args: `--interactive --probe-specifications ${formatShellCommand([destination])}` }),
        },
    }
}

// A native prompt-input stream holds every instruction the tool inherited, including a person's global
// ones, and is larger than the renderer shows, which would hide the summary. It stays in the private
// transcript; the output keeps its digest and size.
function withholdNativeStreams<T extends SelftestEvidenceBundle['records'][number]>(record: T): T {
    if (record.kind !== 'evidence' || record.protocol === undefined) return record
    const withheld = (event: SelftestProbeEvent): SelftestProbeEvent => ({ ...event,
        stdout: `[${Buffer.byteLength(event.stdout)} bytes withheld; see the transcript]`,
        stderr: `[${Buffer.byteLength(event.stderr)} bytes withheld; see the transcript]` })
    return { ...record, ...(record.modelInputs ? { modelInputs: {
        candidate: `[${Buffer.byteLength(record.modelInputs.candidate)} bytes withheld; see the transcript]`,
        broken: `[${Buffer.byteLength(record.modelInputs.broken)} bytes withheld; see the transcript]`,
    } } : {}), events: { ...record.events,
        brokenControl: withheld(record.events.brokenControl), candidateControl: withheld(record.events.candidateControl) } }
}

function selftestRefused(code: Extract<SurfaceSelftestCommandOutcome, { kind: 'refusal' }>['code'], message: string): SurfaceSelftestDispatchOutcome {
    return { status: 2, diagnostics: [{ severity: 'error', code, message }], result: null }
}

// One run, one file: specifications drafted for the cockpit.toml and generated manifest as they are
// now, written beside the run's evidence in the directory sync makes ignore itself. A file kept from
// an earlier run goes stale with the next edit or upgrade, so none is ever reused.
async function writeFreshProbeSpecifications(configPath: string): Promise<string | SurfaceSelftestDispatchOutcome> {
    let root: string
    try { root = dirname(await realpath(resolve(configPath))) } catch (error) {
        return selftestRefused('SELFTEST_SOURCE_INVALID', `configured selftest source could not be resolved: ${errorCause(error)}`)
    }
    const destination = join(root, PROBE_EVIDENCE_ROOT, `probe-specifications-${randomBytes(8).toString('hex')}.json`)
    const drafted = await writeConfiguredSurfaceSelftestSpecifications({ configPath, writeProbeSpecificationsPath: destination })
    // The draft's warnings name custom cells it wrote no row for; the run records each of those as pending.
    if (drafted.status !== 0 || typeof drafted.artifact !== 'string') return drafted
    const directory = await ensureEvidenceDirectory(root)
    if (typeof directory !== 'string') return selftestRefused('SELFTEST_EXECUTION_INVALID', `fresh probe specifications could not be written: ${directory.reason}`)
    try { await writeFile(destination, drafted.artifact, { flag: 'wx', mode: 0o600 }) } catch (error) {
        return selftestRefused('SELFTEST_EXECUTION_INVALID', `fresh probe specifications could not be written to ${destination}: ${errorCause(error)}`)
    }
    return destination
}

export async function runConfiguredSurfaceSelftestOutcome(
    input: SurfaceSelftestHandlerInput | SurfaceSelftestDraftInput,
): Promise<SurfaceSelftestDispatchOutcome> {
    if ('writeProbeSpecificationsPath' in input) return writeConfiguredSurfaceSelftestSpecifications(input)
    const { requestExecutableApproval, requestProbeSpecificationsApproval, rerunUnderNode, probeSpecificationsPath, ...commandInput } = input
    // Fresh specifications exist only to be approved, and only a person at a terminal can approve them.
    if (probeSpecificationsPath === undefined && !requestProbeSpecificationsApproval) return selftestRefused('SELFTEST_EXECUTION_INVALID',
        'probe specifications are written for the run only when a person approves them; run selftest with --interactive at a terminal outside CI, or pass --probe-specifications <file>')
    const artifactPath = probeSpecificationsPath ?? await writeFreshProbeSpecifications(commandInput.configPath)
    if (typeof artifactPath !== 'string') return artifactPath
    // A fresh file is kept only as the record of a run the person approved; one refused, declined or
    // handed to a rerun before approval would only pile up.
    let approved = false
    let outcome: SurfaceSelftestCommandOutcome
    try {
        outcome = await runConfiguredSurfaceSelftestApplication({ ...commandInput, probeSpecificationsPath: artifactPath }, {
            execute: executeProbe,
            ...(requestExecutableApproval ? { requestExecutableApproval } : {}),
            ...(requestProbeSpecificationsApproval ? { requestProbeSpecificationsApproval: async candidate => {
                const confirmation = await requestProbeSpecificationsApproval(candidate)
                approved = confirmation === candidate.sha256
                return confirmation
            } } : {}),
            ...(rerunUnderNode ? { rerunUnderNode } : {}),
        })
    } finally {
        if (probeSpecificationsPath === undefined && !approved) await rm(artifactPath, { force: true })
    }
    if (outcome.kind === 'refusal') return { status: 2, diagnostics: [{ severity: 'error', code: outcome.code, message: outcome.reason,
        ...(outcome.fix ? { fix: outcome.fix } : {}) }], result: null }
    if (outcome.kind === 'rerun') return { status: outcome.status, result: null, diagnostics: outcome.signal === undefined ? []
        : [{ severity: 'error', code: 'SELFTEST_EXECUTION_INVALID', message: `the selftest rerun under the guard's Node was terminated by ${outcome.signal}` }] }
    const responsibilities = {
        native_protocol_unsupported: 'Unmeasurable by selftest as the files stand: each record says whether a change of yours lets selftest measure it; otherwise rerunning does not clear it',
        enforcement_probe_required: 'Maintainer: supply paired native evidence for the custom harness',
        executable_missing: 'Operator: install or locate the named tool before retrying',
        authentication_required: 'Operator: review the executable or complete native authentication before retrying',
        isolation_unavailable: 'Unavailable: the probe cannot establish its required isolation; inspect the report before retrying',
        guard_host_undeclared: 'Operator: declare a vendor endpoint host under [guards] vendor_endpoint_hosts so the Claude Code guard probe has a request the guard refuses, run sync, then write fresh probe specifications',
    } as const
    const failed = outcome.evidence.pending.filter(row => row.reason === 'probe_failed')
    const pending = outcome.evidence.pending.filter((row): row is typeof row & { reason: keyof typeof responsibilities } => row.reason !== 'probe_failed')
    const counts = new Map<keyof typeof responsibilities, number>()
    for (const row of pending) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
    const diagnostics: Diagnostic[] = [
        ...failed.length === 0 ? [] : [{ severity: 'error' as const, code: 'SELFTEST_EXECUTION_INVALID', target: 'probe_failed',
            message: `${failed.length} cell(s) could not be measured; the summary leads with each one, what failed and what to do. Every other cell was still measured` }],
        ...[...counts].map(([reason, count]) => ({ severity: 'warning' as const,
            code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, message: `${count} pending cell(s). ${responsibilities[reason]}`,
            target: reason,
        })),
    ]
    const result = {
        bundle: { ...outcome.bundle, records: outcome.bundle.records.map(withholdNativeStreams) },
        evidence: { ...outcome.evidence, evidence: outcome.evidence.evidence.map(withholdNativeStreams) },
        summary: { failedCells: failed.map(row => ({ cell: surfaceSelftestCellLabel(row), failure: row.operatorAction })),
            measuredCells: outcome.evidence.evidence.length, pendingCells: pending.length,
            unavailableCells: outcome.evidence.evidence.filter(row => row.verdict === 'unavailable').length,
            pendingSkillReviews: outcome.evidence.skillReviews.filter(row => row.status === 'human_needed').length,
            // Unsupported cells and skill reviews, which no command performs or records, are reported
            // beside it rather than holding it false forever.
            measurementComplete: outcome.measurementComplete },
    }
    try {
        const directory = await ensureEvidenceDirectory(outcome.root)
        if (typeof directory !== 'string') throw new Error(directory.reason)
        const reportPath = join(directory, `selftest-${randomBytes(16).toString('hex')}.json`)
        const report = { result: { ...result, reportPath }, diagnostics }
        await writeFile(reportPath, `${JSON.stringify(report)}\n`, { flag: 'wx', mode: 0o600 })
        return { status: outcome.status, ...report }
    } catch (error) {
        return { status: 2, result, diagnostics: [...diagnostics, { severity: 'error', code: 'SELFTEST_EXECUTION_INVALID',
            message: `selftest report could not be saved: ${errorCause(error)}` }] }
    }
}

function selftestOperatorRefusal(message: string): SurfaceSelftestDispatchOutcome {
    return {
        artifact: null, destination: null,
        status: 2, result: null,
        diagnostics: [{ severity: 'error', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, message, target: 'selftest' }],
    }
}

async function confirmSelftestExecutable(
    io: SelftestOperatorIo,
    candidate: SurfaceSelftestExecutableCandidate,
): Promise<string | undefined> {
    if (io.confirmSelftestExecutable) return io.confirmSelftestExecutable(candidate)
    if (!io.stdin) return undefined
    io.stderr.write(renderHumanValue({ executable: candidate.canonicalPath, harness: candidate.harness, sha256: candidate.sha256 }))
    return confirmDigest(io, candidate.sha256, 'Approve this executable for this selftest run?')
}

type CommandVector = SurfaceSelftestProbeSpecificationsCandidate['commandVectors'][number]

function withSkill(template: CommandVector, skill: string): CommandVector {
    return { ...template, skill, invocation: template.invocation.map(value => value.replaceAll('{skill}', skill)) as [string, ...string[]] }
}

/**
 * The runnable commands as a person reviews them. Rows that differ only in their skill are shown once,
 * with `{skill}` in its place and the skills it runs for; a row its template does not reproduce exactly
 * is shown whole, so the display stays a lossless reading of the approved file.
 */
export function selftestApprovalCommands(rows: readonly CommandVector[]): readonly (CommandVector | Readonly<{ template: CommandVector; skills: readonly string[] }>)[] {
    const shown: (CommandVector | { template: CommandVector; skills: string[] })[] = []
    const groups = new Map<string, { template: CommandVector; skills: string[] }>()
    for (const row of rows) {
        const skill = row.skill
        const template = skill === null ? undefined
            : { ...row, skill: '{skill}', invocation: row.invocation.map(value => value.replaceAll(skill, '{skill}')) as [string, ...string[]] }
        if (!template || !isDeepStrictEqual(withSkill(template, skill!), row)) { shown.push(row); continue }
        const key = JSON.stringify(template)
        const group = groups.get(key)
        if (group) { group.skills.push(skill!); continue }
        const created = { template, skills: [skill!] }
        groups.set(key, created)
        shown.push(created)
    }
    return shown
}

async function confirmSelftestProbeSpecifications(
    io: SelftestOperatorIo,
    candidate: SurfaceSelftestProbeSpecificationsCandidate,
): Promise<string | undefined> {
    if (io.confirmSelftestProbeSpecifications) return io.confirmSelftestProbeSpecifications(candidate)
    if (!io.stdin) return undefined
    const runnable = candidate.commandVectors.filter(row => row.executes !== false)
    io.stderr.write(renderHumanValue({ artifact: candidate.canonicalPath, sha256: candidate.sha256,
        sourceSha256: candidate.sourceSha256, generatedManifestSha256: candidate.generatedManifestSha256,
        runnableCommands: selftestApprovalCommands(runnable) }))
    io.stderr.write(`${runnable.length} runnable command(s) above, shown once per skill template; ${candidate.canonicalPath} holds each one in full.\n`)
    if (candidate.guardProbeTeamHooks) {
        io.stderr.write('Team hooks the Claude Code guard probe loads beside cockpit\'s guard; Claude Code runs each one its event and matcher select, with its script as it is on disk now:\n')
        io.stderr.write(renderHumanValue(candidate.guardProbeTeamHooks))
    }
    io.stderr.write(`${candidate.commandVectors.length - runnable.length} unsupported cell(s) execute nothing and remain incomplete.\n`)
    return confirmDigest(io, candidate.sha256, 'Approve this artifact and its runnable commands for this selftest run?')
}

export async function runSelftestOperatorCommand(
    input: SurfaceSelftestHandlerInput,
    options: SelftestOperatorOptions,
    io: SelftestOperatorIo,
    handler: (input: SurfaceSelftestHandlerInput) => Promise<SurfaceSelftestDispatchOutcome>,
): Promise<SurfaceSelftestDispatchOutcome> {
    if (!options.interactive) return handler(input)
    if (options.json || options.ci && options.ci.length > 0) {
        return selftestOperatorRefusal('interactive selftest requires a human terminal outside CI and JSON modes')
    }
    if ((!io.confirmSelftestExecutable || !io.confirmSelftestProbeSpecifications) && io.stdin?.isTTY !== true) {
        return selftestOperatorRefusal('interactive selftest requires terminal input')
    }
    return handler({
        ...input,
        requestExecutableApproval: (candidate) => confirmSelftestExecutable(io, candidate),
        requestProbeSpecificationsApproval: (candidate) => confirmSelftestProbeSpecifications(io, candidate),
        ...options.rerunUnderNode ? { rerunUnderNode: options.rerunUnderNode } : {},
    })
}
