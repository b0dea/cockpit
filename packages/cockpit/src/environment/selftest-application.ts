import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { types as utilTypes } from 'node:util'

import {
    PROBE_EVIDENCE_ROOT,
    validateSelftestEvidenceBundle,
    type SelftestEvidenceBundle,
    type SelftestEvidenceRecord,
    type SelftestProbeEvent,
} from '../../libexec/validate-harness-evidence.mjs'
import { authenticatedExecutionOutcome, executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import type { Diagnostic } from '../diagnostics.js'
import {
    checkGeneratedEnvironment,
    generatedApplicationProjection,
    type GeneratedApplicationProjection,
} from './generated-application.js'
import { redactSensitiveMessage } from './sensitive.js'
import {
    snapshotExecutionStep, snapshotGeneratedJson, ENVIRONMENT_CODES, INHERITED_TOOL_ENVIRONMENT, type ConsumedFile, type ExecutionStep,
} from './contract.js'
import { resolveExecutable, type ResolvedExecutable } from './executable.js'
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
    type SelftestProbeSpecification,
} from '../surfaces/selftest.js'

export const mechanism = {
    id: 'surface-selftest-application',
    module: 'packages/cockpit/src/environment/selftest-application.ts',
    exports: [
        'runSurfaceSelftestApplication', 'runConfiguredSurfaceSelftestApplication',
        'runConfiguredSurfaceSelftestOutcome', 'runSelftestOperatorCommand', 'writeConfiguredSurfaceSelftestSpecifications',
    ],
} as const

export interface ConfiguredSurfaceSelftestCommandInput {
    readonly configPath: string
    readonly probeSpecificationsPath: string
    readonly env: Readonly<Record<string, string | undefined>>
}

export interface SurfaceSelftestDraftInput {
    readonly configPath: string
    readonly writeProbeSpecificationsPath: string
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
        versionCommand: readonly [string, ...string[]]
        helpCommand: readonly [string, ...string[]]
    }>[]
}

export interface SurfaceSelftestCommandAdapters {
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    readonly requestExecutableApproval?: (candidate: SurfaceSelftestExecutableCandidate) => Promise<string | undefined>
    readonly requestProbeSpecificationsApproval?: (
        candidate: SurfaceSelftestProbeSpecificationsCandidate,
    ) => Promise<string | undefined>
    readonly testOnlyExecutableIdentities?: Partial<Record<'Claude Code' | 'Codex' | 'OpenCode', readonly string[]>>
}

export type SurfaceSelftestCommandOutcome =
    | Readonly<{
        kind: 'complete'
        status: 0
        bundle: SelftestEvidenceBundle
        evidence: ReturnType<typeof validateSelftestEvidenceBundle>
    }>
    | Readonly<{ kind: 'refusal'; status: 2; code: 'SELFTEST_SOURCE_INVALID' | 'SELFTEST_EXECUTION_INVALID'; reason: string; fix?: string }>

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
        return Object.freeze(env)
    } catch { return undefined }
}

function commandInput(value: unknown): SurfaceSelftestCommandInput | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const required = ['application', 'env', 'root', 'specifications']
        const allowed = new Set(required)
        if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))
            || required.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value'))
            || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) return undefined
        const root = descriptors.root!.value
        const env = captureProbeEnvironment(descriptors.env!.value)
        const specifications = descriptors.specifications!.value
        if (typeof root !== 'string' || !env || !Array.isArray(specifications)) return undefined
        return Object.freeze({ application: descriptors.application!.value, root, specifications, env }) as SurfaceSelftestCommandInput
    } catch { return undefined }
}

function configuredCommandInput(value: unknown): ConfiguredSurfaceSelftestCommandInput | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const required = ['configPath', 'env', 'probeSpecificationsPath']
        const allowed = new Set(required)
        if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))
            || required.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value'))
            || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) return undefined
        const configPath = descriptors.configPath!.value
        const probeSpecificationsPath = descriptors.probeSpecificationsPath!.value
        const env = captureProbeEnvironment(descriptors.env!.value)
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')
            || typeof probeSpecificationsPath !== 'string' || probeSpecificationsPath.length === 0
            || probeSpecificationsPath.includes('\0') || !env) return undefined
        return Object.freeze({ configPath, probeSpecificationsPath, env })
    } catch { return undefined }
}

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex')
}

function refusal(code: Extract<SurfaceSelftestCommandOutcome, { kind: 'refusal' }>['code'], reason: string): SurfaceSelftestCommandOutcome {
    return Object.freeze({ kind: 'refusal', status: 2, code, reason })
}

async function readProbeSpecificationsArtifact(path: string): Promise<string | undefined> {
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
    } catch { return undefined } finally { await handle?.close() }
}

const PROBE_SPECIFICATIONS_SCHEMA = 'cockpit-selftest-probe-specifications/v1'

// The file carries no digest of its own rows: a person edits them, and a digest anyone can
// recompute would prove nothing. What binds the rows is the approval of the whole file's SHA-256.
function probeSpecificationsArtifact(
    bytes: string,
    sourceSha256: string,
    generatedManifestSha256: string,
): Readonly<{ kind: 'complete'; specifications: readonly unknown[] }> | Readonly<{ kind: 'malformed' }> | Readonly<{ kind: 'stale' }> {
    let captured: Readonly<Record<string, unknown>> | undefined
    try { captured = snapshotGeneratedJson(JSON.parse(bytes)) as Readonly<Record<string, unknown>> | undefined } catch { return { kind: 'malformed' } }
    if (!captured || Object.keys(captured).sort().join('\0') !== ['generatedManifestSha256', 'schema', 'sourceSha256', 'specifications'].join('\0')
        || captured.schema !== PROBE_SPECIFICATIONS_SCHEMA || !Array.isArray(captured.specifications)) return { kind: 'malformed' }
    if (captured.sourceSha256 !== sourceSha256 || captured.generatedManifestSha256 !== generatedManifestSha256) return { kind: 'stale' }
    return { kind: 'complete', specifications: captured.specifications }
}

// Every refusal about the file itself names the command that writes a fresh one.
function probeSpecificationsRefusal(reason: string): SurfaceSelftestCommandOutcome {
    return {
        kind: 'refusal', status: 2, code: 'SELFTEST_SOURCE_INVALID', reason,
        fix: 'write a new file with npx --no cockpit selftest --config <your cockpit.toml> --write-probe-specifications <new file>, fill the fields it lists, then pass that file to --probe-specifications',
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
        const confirmation = await adapters.requestExecutableApproval(Object.freeze({
            harness, canonicalPath: executable.canonicalPath, sha256: executable.sha256,
        }))
        if (confirmation === executable.sha256) {
            approved.set(harness, Object.freeze({ canonicalPath: executable.canonicalPath, sha256: executable.sha256 }))
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
            } catch { continue }
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

function boundedStream(value: Buffer): string | undefined {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(value) } catch { return undefined }
    const redacted = redactSensitiveMessage(text)
    if (redacted === undefined) return undefined
    text = redacted
    if (Buffer.byteLength(text) > STREAM_BYTES) return undefined
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
): ExecutionStep | undefined {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    return snapshotExecutionStep({
        id, argv, argv0, cwd: root, env, timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining),
        spawnNotAfter: new Date(deadline).toISOString(), stdoutLimitBytes: STREAM_BYTES, stderrLimitBytes: STREAM_BYTES,
        paths: [root], ports: [], labels, expected: [], consumedFiles, filesystemChecks: [], compensation: [],
    })
}

async function run(
    adapters: SurfaceSelftestCommandAdapters,
    value: ExecutionStep | undefined,
): Promise<{ outcome: ExecuteProbeOutcome; startedAt: string; finishedAt: string } | undefined> {
    if (!value) return undefined
    const startedAt = new Date().toISOString()
    const outcome = authenticatedExecutionOutcome(await adapters.execute(value), value)
    const finishedAt = new Date().toISOString()
    return outcome ? { outcome, startedAt, finishedAt } : undefined
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
): SelftestProbeEvent | undefined {
    const stdout = boundedStream(execution.stdout)
    const stderr = boundedStream(execution.stderr)
    if (stdout === undefined || stderr === undefined) return undefined
    return Object.freeze({
        cwd, command: Object.freeze([...command]), exitCode: execution.execution.exitCode,
        signal: execution.execution.signal, result, code, stdout, stderr,
        stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
    })
}

function selectedEntryBytes(probe: PlannedSelftestProbe): string | undefined {
    const selected = probe.entries.find((entry) => {
        if (probe.cell.capability === 'skill-parity') return entry.path.includes(`/skills/${probe.cell.skill}/`)
        if (probe.harness.kind !== 'builtin') return false
        if (probe.capability === 'instruction-loading') return probe.harness.target === 'claudecode'
            ? entry.path === 'CLAUDE.md' || entry.path === 'CLAUDE.local.md'
            : probe.harness.target === 'codexcli' ? entry.path === 'AGENTS.md' : entry.path === 'opencode.jsonc'
        if (probe.harness.target === 'claudecode') return entry.path === '.claude/settings.json'
        if (probe.harness.target === 'codexcli') return entry.path === '.codex/config.toml'
            || entry.path.startsWith('.codex/rules/')
        return entry.path === 'opencode.jsonc'
    })
    if (!selected) return undefined
    if (selected.kind === 'file') return selected.bytes
    if (selected.kind === 'symlink') return JSON.stringify({ target: selected.target, source: selected.source })
    return selected.region.format === 'markdown-delimited'
        ? selected.region.bytes
        : `${JSON.stringify(Object.fromEntries(selected.region.members.map((member) => [member.key, JSON.parse(member.valueBytes)])), null, 2)}\n`
}

function authenticationRequired(outcome: ExecuteProbeOutcome): boolean {
    const text = `${outcome.stdout.toString('utf8')}\n${outcome.stderr.toString('utf8')}`
    return /(?:not authenticated|not logged in|authentication required|unauthorized|\b401\b|\b403\b)/i.test(text)
}

async function ensurePlainDirectory(path: string): Promise<boolean> {
    try {
        const status = await lstat(path)
        return status.isDirectory() && !status.isSymbolicLink() && await realpath(path) === path
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
        try { await mkdir(path, { mode: 0o700 }) } catch (createError) {
            if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') return false
        }
        try {
            const status = await lstat(path)
            return status.isDirectory() && !status.isSymbolicLink() && await realpath(path) === path
        } catch { return false }
    }
}

async function ensureEvidenceDirectory(root: string): Promise<string | undefined> {
    try {
        if (await realpath(root) !== root) return undefined
        let directory = root
        for (const segment of PROBE_EVIDENCE_ROOT.split('/')) {
            directory = join(directory, segment)
            if (!await ensurePlainDirectory(directory)) return undefined
        }
        return directory
    } catch { return undefined }
}

async function writeControlPair(
    directory: string,
    probe: PlannedSelftestProbe,
): Promise<{ candidate: string; broken: string; candidateSha256: string; brokenSha256: string } | undefined> {
    try {
        const candidate = join(directory, 'candidate.json')
        const broken = join(directory, 'broken.json')
        const candidateBytes = selectedEntryBytes(probe)
        if (!candidateBytes || Buffer.byteLength(candidateBytes) > MAX_CONTROL_BYTES) return undefined
        const brokenBytes = '{\n'
        await writeFile(candidate, candidateBytes, { flag: 'wx', mode: 0o600 })
        await writeFile(broken, brokenBytes, { flag: 'wx', mode: 0o600 })
        return { candidate, broken, candidateSha256: sha256(candidateBytes), brokenSha256: sha256(brokenBytes) }
    } catch { return undefined }
}

function consumedExecutable(executable: ResolvedExecutable): ConsumedFile {
    return {
        path: executable.canonicalPath, sha256: executable.sha256, maxBytes: MAX_EXECUTABLE_BYTES,
        argvIndexes: [0], executable: true, executionMode: executable.executionMode,
    }
}

async function runEvidenceProbe(
    root: string,
    evidenceRoot: string | undefined,
    expectation: SelftestExpectation,
    probe: PlannedSelftestProbe,
    env: SurfaceSelftestCommandInput['env'],
    adapters: SurfaceSelftestCommandAdapters,
    approvedExecutables: OperatorExecutableIdentities,
): Promise<SelftestEvidenceRecord | ReturnType<typeof surfaceSelftestHumanNeeded> | undefined> {
    const harnessName = probe.harness.name
    const observedAt = new Date().toISOString()
    const resolution = await resolveExecutable(BUILTIN_EXECUTABLES[probe.harness.target], env)
    if (resolution.state === 'unavailable') return surfaceSelftestHumanNeeded(
        expectation,
        probe.cell, 'executable_missing', observedAt,
        `${resolution.reason}; install ${harnessName} on a supported host, sign in, and rerun its ${probe.capability} probe`,
    )
    const executable = resolution.value
    if (!await hasExecutableAuthority(adapters, approvedExecutables, probe.harness.name, executable)) {
        return surfaceSelftestHumanNeeded(
            expectation, probe.cell, 'authentication_required', observedAt,
            `Provide an operator-approved absolute executable identity for ${harnessName} and rerun its ${probe.capability} probe`,
        )
    }
    if (!evidenceRoot) return surfaceSelftestHumanNeeded(
        expectation, probe.cell, 'isolation_unavailable', observedAt,
        `${PROBE_EVIDENCE_ROOT} could not be created as a plain directory, so probe controls cannot be kept apart from the checkout; make it a plain directory and rerun the ${harnessName} ${probe.capability} probe`,
    )
    let directory: string
    try {
        directory = join(evidenceRoot, `selftest-${randomBytes(12).toString('hex')}`)
        await mkdir(directory, { mode: 0o700 })
    } catch { return undefined }
    const controls = await writeControlPair(directory, probe)
    if (!controls) return undefined
    const candidatePath = relativeEvidencePath(root, controls.candidate)
    const brokenPath = relativeEvidencePath(root, controls.broken)
    const transcript = join(directory, 'transcript.json')
    const transcriptPath = relativeEvidencePath(root, transcript)
    if (!candidatePath || !brokenPath || !transcriptPath) return undefined

    const deadline = Date.now() + EVIDENCE_EXPIRY_MS
    const invocation = publicCommand(probe.invocation, executable.canonicalPath)
    const versionCommand = publicCommand(probe.versionCommand, executable.canonicalPath)
    const helpCommand = publicCommand(probe.helpCommand, executable.canonicalPath)
    const commonFiles = Object.freeze([consumedExecutable(executable)])
    const probeEnvironment = Object.freeze(Object.fromEntries(Object.entries(env).filter(
        (row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0 && !row[1].includes('\0'))))
    const controlIndex = invocation.indexOf('{control}')
    if (controlIndex < 0) return undefined
    const candidateCommand = publicCommand(invocation, executable.canonicalPath, candidatePath)
    const brokenCommand = publicCommand(invocation, executable.canonicalPath, brokenPath)
    const createStep = (role: string, command: readonly [string, ...string[]], control?: typeof controls.candidate): ExecutionStep | undefined => {
        const execution = executionCommand(command, root, control ? relativeEvidencePath(root, control) : undefined)
        const files = [...commonFiles]
        if (control) files.push({ path: control, sha256: control === controls.candidate ? controls.candidateSha256 : controls.brokenSha256,
            maxBytes: MAX_CONTROL_BYTES, argvIndexes: [controlIndex], executable: false })
        return step(`surface-selftest-${randomBytes(8).toString('hex')}-${role}`, root, execution, executable.invocationPath, files, deadline,
            { harness: harnessName, capability: probe.capability, role }, probeEnvironment)
    }
    const version = await run(adapters, createStep('version', versionCommand))
    const help = await run(adapters, createStep('help', helpCommand))
    const broken = await run(adapters, createStep('broken', brokenCommand, controls.broken))
    const candidate = await run(adapters, createStep('candidate', candidateCommand, controls.candidate))
    if (!version || !help || !broken || !candidate) return undefined
    if ([version, help, broken, candidate].some((row) => authenticationRequired(row.outcome))) {
        return surfaceSelftestHumanNeeded(
            expectation, probe.cell, 'authentication_required', observedAt,
            `Authenticate ${harnessName} and rerun its ${probe.capability} probe`,
        )
    }
    if (version.outcome.kind !== 'complete' || help.outcome.kind !== 'complete') return undefined
    const brokenOutput = `${broken.outcome.stdout.toString('utf8')}\n${broken.outcome.stderr.toString('utf8')}`
    if (broken.outcome.kind !== 'refusal' || !exactLine(brokenOutput, probe.brokenCode)) return undefined
    const candidateOutput = `${candidate.outcome.stdout.toString('utf8')}\n${candidate.outcome.stderr.toString('utf8')}`
    let verdict: SelftestEvidenceRecord['verdict']
    let candidateResult: SelftestProbeEvent['result']
    let candidateCode: string
    if (candidate.outcome.kind === 'complete' && exactLine(candidateOutput, probe.candidateCode)) {
        verdict = 'instructed'; candidateResult = 'accepted'; candidateCode = probe.candidateCode
    } else if (candidate.outcome.kind === 'refusal' && probe.capability === 'guard-firing' && exactLine(candidateOutput, probe.candidateCode)) {
        verdict = 'enforced'; candidateResult = 'refused'; candidateCode = probe.candidateCode
    } else if (exactLine(candidateOutput, probe.unavailableCode)) {
        verdict = 'unavailable'; candidateResult = candidate.outcome.kind === 'complete' ? 'allowed' : 'unavailable'; candidateCode = probe.unavailableCode
    } else return undefined
    const startedAt = version.startedAt
    const finishedAt = candidate.finishedAt
    const expiresAt = new Date(Math.min(Date.parse(startedAt) + EVIDENCE_EXPIRY_MS, deadline)).toISOString()
    const events = {
        version: event(versionCommand, '.', version.outcome, 'completed', 'VERSION_OK'),
        help: event(helpCommand, '.', help.outcome, 'completed', 'HELP_OK'),
        brokenControl: event(brokenCommand, '.', broken.outcome, 'rejected', probe.brokenCode),
        candidateControl: event(candidateCommand, '.', candidate.outcome, candidateResult, candidateCode),
    }
    if (!events.version || !events.help || !events.brokenControl || !events.candidateControl) return undefined
    const versionText = `${events.version.stdout} ${events.version.stderr}`.trim()
    const versionValue = versionText.split(/\s+/).find(Boolean)
    if (!versionValue || Buffer.byteLength(versionValue) > 256) return undefined
    const record: SelftestEvidenceRecord = {
        kind: 'evidence', harness: probe.harness, capability: probe.capability,
        generatedManifestSha256: expectation.generatedManifestSha256, verdict, version: versionValue, measuredOn: startedAt.slice(0, 10),
        runId: `selftest-${randomBytes(16).toString('hex')}`, startedAt, finishedAt, expiresAt,
        candidatePath, brokenPath, transcriptPath, candidateSha256: controls.candidateSha256,
        brokenSha256: controls.brokenSha256, transcriptSha256: '', invocation: Object.freeze([...invocation]),
        versionCommand: Object.freeze([...versionCommand]), helpCommand: Object.freeze([...helpCommand]),
        candidateCode, brokenCode: probe.brokenCode, sample: probe.sample,
        authority: Object.freeze({ kind: 'native-executable', name: probe.harness.name, executable: executable.canonicalPath }),
        events: Object.freeze(events as SelftestEvidenceRecord['events']),
    }
    const { transcriptSha256: _transcriptSha256, ...transcriptRecord } = record
    void _transcriptSha256
    const transcriptBytes = JSON.stringify(transcriptRecord)
    await writeFile(transcript, transcriptBytes, { flag: 'wx', mode: 0o600 })
    return Object.freeze({ ...record, transcriptSha256: sha256(transcriptBytes) })
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
    for (const probe of plan.probes) {
        const record = await runEvidenceProbe(
            root, evidenceRoot, plan.expectation, probe, capturedInput.env, adapters, approvedExecutables,
        )
        if (!record) return refusal('SELFTEST_EXECUTION_INVALID', `probe execution could not establish ${probe.capability} for ${probe.harness.name}`)
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
    const bundle: SelftestEvidenceBundle = Object.freeze({
        schema: 'cockpit-harness-selftest/v1', generatedManifestSha256: plan.expectation.generatedManifestSha256,
        records: Object.freeze(records), skillInventory: plan.expectation.shippedSkills, skillReviews: reviews,
    })
    const testOnlyExecutableIdentities = process.env.NODE_ENV === 'test'
        ? adapters.testOnlyExecutableIdentities : undefined
    const evidence = validateSelftestEvidenceBundle(bundle, plan.expectation, root, {
        operatorExecutableIdentities: approvedExecutables,
        testOnlyExecutableIdentities,
    })
    if (evidence.errors.length > 0) return refusal('SELFTEST_EXECUTION_INVALID', evidence.errors.join('; '))
    return Object.freeze({ kind: 'complete', status: 0, bundle, evidence })
}

export async function runConfiguredSurfaceSelftestApplication(
    input: ConfiguredSurfaceSelftestCommandInput,
    adapters: SurfaceSelftestCommandAdapters = defaultAdapters,
): Promise<SurfaceSelftestCommandOutcome> {
    const capturedInput = configuredCommandInput(input)
    if (!capturedInput) return refusal('SELFTEST_SOURCE_INVALID', 'configured selftest input must contain only bounded own data')
    let configPath: string
    try { configPath = await realpath(resolve(capturedInput.configPath)) } catch {
        return refusal('SELFTEST_SOURCE_INVALID', 'configured selftest source could not be resolved')
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
    try { artifactPath = await realpath(requestedArtifactPath) } catch {
        return probeSpecificationsRefusal(`probe specification file ${requestedArtifactPath} is missing or unreadable`)
    }
    const bytes = await readProbeSpecificationsArtifact(artifactPath)
    if (bytes === undefined) return probeSpecificationsRefusal(`probe specification file ${artifactPath} is missing, unreadable, not a regular file or larger than ${MAX_PROBE_SPECIFICATIONS_BYTES} bytes`)
    const artifact = probeSpecificationsArtifact(
        bytes,
        checked.result.application.sourceSha256,
        checked.result.application.surfaceSelftest.manifestSha256,
    )
    if (artifact.kind === 'malformed') {
        return probeSpecificationsRefusal(`probe specification file ${artifactPath} is not ${PROBE_SPECIFICATIONS_SCHEMA} JSON with exactly schema, sourceSha256, generatedManifestSha256 and specifications`)
    }
    if (artifact.kind === 'stale') {
        return probeSpecificationsRefusal(`probe specification file ${artifactPath} was written for a different cockpit.toml or generated manifest`)
    }
    const unfilled = unfilledSurfaceSelftestSpecifications(artifact.specifications)
    if (unfilled.length > 0) {
        return {
            kind: 'refusal', status: 2, code: 'SELFTEST_SOURCE_INVALID',
            reason: `probe specification file ${artifactPath} still has ${unfilled.length} row(s) with fields only a person can supply: ${unfilled.slice(0, 5).join('; ')}${unfilled.length > 5 ? `; and ${unfilled.length - 5} more` : ''}`,
            fix: 'replace each null in the listed rows with the probe for that tool, then rerun selftest with the same file',
        }
    }
    const specifications = artifact.specifications as readonly SelftestProbeSpecification[]
    const plan = planSurfaceSelftest(checked.result.application.surfaceSelftest, specifications)
    if (plan.kind === 'refusal') return refusal(plan.code, plan.reason)
    const artifactSha256 = sha256(bytes)
    const candidate: SurfaceSelftestProbeSpecificationsCandidate = Object.freeze({
        canonicalPath: artifactPath,
        sha256: artifactSha256,
        sourceSha256: checked.result.application.sourceSha256,
        generatedManifestSha256: checked.result.application.surfaceSelftest.manifestSha256,
        commandVectors: Object.freeze(plan.probes.map((probe) => Object.freeze({
            harness: probe.harness.name,
            capability: probe.capability,
            skill: probe.sample?.skill ?? null,
            invocation: Object.freeze([...probe.invocation]) as readonly [string, ...string[]],
            versionCommand: Object.freeze([...probe.versionCommand]) as readonly [string, ...string[]],
            helpCommand: Object.freeze([...probe.helpCommand]) as readonly [string, ...string[]],
        }))),
    })
    const confirmation = await adapters.requestProbeSpecificationsApproval?.(candidate)
    if (confirmation !== artifactSha256) {
        // No `fix` field: the diagnostic index would print it as the remedy for every
        // SELFTEST_EXECUTION_INVALID, including probes that ran and failed.
        return refusal(
            'SELFTEST_EXECUTION_INVALID',
            'probe specification artifact requires independent approval of its exact digest and command vectors; run selftest with --interactive at a terminal outside CI and type the file SHA-256 it displays',
        )
    }
    return runSurfaceSelftestApplication({
        application: checked.result.application,
        root: dirname(configPath),
        specifications,
        env: capturedInput.env,
    }, adapters)
}

export interface SurfaceSelftestHandlerInput extends ConfiguredSurfaceSelftestCommandInput {
    readonly requestExecutableApproval?: SurfaceSelftestCommandAdapters['requestExecutableApproval']
    readonly requestProbeSpecificationsApproval?: SurfaceSelftestCommandAdapters['requestProbeSpecificationsApproval']
}

export interface SurfaceSelftestDispatchOutcome {
    readonly artifact?: string | null
    readonly destination?: string | null
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
}

/**
 * Writes the probe-specification file for the current cockpit.toml and generated manifest. The CLI
 * creates `destination` and refuses an existing path, so a filled-in file is never overwritten.
 */
export async function writeConfiguredSurfaceSelftestSpecifications(
    input: SurfaceSelftestDraftInput,
): Promise<SurfaceSelftestDispatchOutcome> {
    const refused = (message: string): SurfaceSelftestDispatchOutcome => ({
        status: 2, diagnostics: [{ severity: 'error', code: 'SELFTEST_SOURCE_INVALID', message }], result: null,
    })
    let configPath: string
    try { configPath = await realpath(resolve(input.configPath)) } catch {
        return refused('configured selftest source could not be resolved')
    }
    const checked = await checkGeneratedEnvironment({ configPath })
    if (checked.kind !== 'complete') {
        return refused(checked.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('; ')
            || 'generated environment check refused configured selftest source')
    }
    const draft = draftSurfaceSelftestSpecifications(checked.result.application.surfaceSelftest)
    if (!draft) return refused('generated selftest projection is invalid')
    const { specifications, unprobeable } = draft
    const destination = resolve(input.writeProbeSpecificationsPath)
    const unfilled = unfilledSurfaceSelftestSpecifications(specifications)
    return {
        status: 0,
        diagnostics: unprobeable.map((cell) => ({
            severity: 'warning' as const,
            code: 'SELFTEST_CUSTOM_PROBE_UNSUPPORTED' satisfies typeof ENVIRONMENT_CODES.SELFTEST_CUSTOM_PROBE_UNSUPPORTED,
            message: `no row written for ${surfaceSelftestCellLabel(cell)}: ${UNPROBEABLE_REASON}, so selftest records this cell human_needed with enforcement_probe_required`,
            target: surfaceSelftestCellLabel(cell),
            fix: 'measure the custom harness capability by hand with a candidate and a deliberately broken control, then record what you saw as its state and measured_on in cockpit.toml (enforced needs an evidence file); do not add a row for it',
        })),
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
            fromCockpit: 'versionCommand and helpCommand, the --version and --help identity probes; review them when you approve the file',
            fromYou: 'each null: invocation (argv starting with the placeholder already in versionCommand, with exactly one {control}), candidateCode and brokenCode (the exact lines the tool prints for an accepted and a broken control), and sample.features for skill-parity rows',
            unfilled,
            then: cockpitCommand('selftest', { config: configPath, args: `--interactive --probe-specifications ${formatShellCommand([destination])}` }),
        },
    }
}

export async function runConfiguredSurfaceSelftestOutcome(
    input: SurfaceSelftestHandlerInput | SurfaceSelftestDraftInput,
): Promise<SurfaceSelftestDispatchOutcome> {
    if ('writeProbeSpecificationsPath' in input) return writeConfiguredSurfaceSelftestSpecifications(input)
    const { requestExecutableApproval, requestProbeSpecificationsApproval, ...commandInput } = input
    const outcome = await runConfiguredSurfaceSelftestApplication(commandInput, {
        execute: executeProbe,
        ...(requestExecutableApproval ? { requestExecutableApproval } : {}),
        ...(requestProbeSpecificationsApproval ? { requestProbeSpecificationsApproval } : {}),
    })
    return outcome.kind === 'complete'
        ? { status: 0, diagnostics: [], result: { bundle: outcome.bundle, evidence: outcome.evidence } }
        : { status: 2, diagnostics: [{ severity: 'error', code: outcome.code, message: outcome.reason,
            ...(outcome.fix ? { fix: outcome.fix } : {}) }], result: null }
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
    io.stderr.write(`${JSON.stringify(candidate)}\n`)
    const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
    try {
        const answer = await prompt.question('Type the exact SHA-256 to approve this executable for this selftest run: ')
        return answer.trim()
    } finally {
        prompt.close()
    }
}

async function confirmSelftestProbeSpecifications(
    io: SelftestOperatorIo,
    candidate: SurfaceSelftestProbeSpecificationsCandidate,
): Promise<string | undefined> {
    if (io.confirmSelftestProbeSpecifications) return io.confirmSelftestProbeSpecifications(candidate)
    if (!io.stdin) return undefined
    io.stderr.write(`${JSON.stringify(candidate)}\n`)
    const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
    try {
        const answer = await prompt.question('Type the exact SHA-256 to approve this probe artifact and its command vectors: ')
        return answer.trim()
    } finally {
        prompt.close()
    }
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
    })
}
