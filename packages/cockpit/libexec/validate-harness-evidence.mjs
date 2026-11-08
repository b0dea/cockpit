import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual, types as utilTypes } from 'node:util'
import { nativeGuardInvocation, validNativeGuardHookCommand, validateNativeGuardPair } from './native-selftest-guard.mjs'
import { MODEL_INPUT_PROTOCOLS, nativeClaudeImport, nativeInputSettings, nativeInputInvocation, validateNativeModelInputPair } from './native-selftest-input.mjs'

// Unlike the TypeScript helper this cannot import: system errors keep their first message line;
// anything else gives only its class, because parse messages echo the evidence bytes.
function errorCause(error) {
    if (!(error instanceof Error)) return 'a non-error value was thrown'
    const message = Object.getOwnPropertyDescriptor(error, 'message')?.value
    if (typeof error.code === 'string' && typeof error.syscall === 'string' && typeof message === 'string') {
        return message.split(/\r?\n|\r/, 1)[0].slice(0, 240)
    }
    return error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError'
        : error instanceof RangeError ? 'RangeError' : 'Error'
}

const HARNESSES = ['Claude Code', 'Codex', 'OpenCode']
const CAPABILITIES = ['sandbox', 'approval']
const VERDICTS = ['enforced', 'unavailable']
const REQUIRED_TEXT = [
    'harness',
    'version',
    'date',
    'capability',
    'candidatePath',
    'brokenPath',
    'transcriptPath',
    'candidateSha256',
    'brokenSha256',
    'transcriptSha256',
    'runId',
    'forbiddenAction',
    'verdict',
    'syntheticFixture',
]
const EVENT_NAMES = ['version', 'help', 'brokenControl', 'candidateControl']
const EVENT_RESULTS = ['completed', 'rejected', 'accepted', 'refused', 'allowed', 'unavailable']
const ZERO_EXIT_RESULTS = ['completed', 'accepted', 'allowed']
const GENERIC_COMMAND_LAUNCHERS = new Set([
    'ash',
    'bash',
    'bun',
    'bunx',
    'cmd',
    'dash',
    'deno',
    'env',
    'fish',
    'java',
    'ksh',
    'node',
    'nodejs',
    'npx',
    'perl',
    'php',
    'powershell',
    'pwsh',
    'python',
    'ruby',
    'sh',
    'ts-node',
    'tsx',
    'zsh',
])
const HARNESS_EXECUTABLE_IDENTITIES = Object.freeze({
    'Claude Code': ['claude'],
    Codex: ['codex'],
    OpenCode: ['opencode'],
})
// Bundled native runtimes exceed evidence stream sizes; their hashes still need a fixed work ceiling.
const HARNESS_EXECUTABLE_MAX_BYTES = 536_870_912
const LEGACY_EVIDENCE_MAX_BYTES = 1_048_576
const LEGACY_MANIFEST_MAX_BYTES = 1_048_576
const LEGACY_COMMAND_MAX_ARGUMENTS = 256
const LEGACY_COMMAND_MAX_BYTES = 1_048_576
const LEGACY_TEXT_MAX_BYTES = 1_048_576

// Probe controls and transcripts live in the checkout's machine-local state, which cockpit's
// generated ignore block already excludes, so evidence never lands in tracked files.
export const PROBE_EVIDENCE_ROOT = '.cockpit/local/probes'

function isText(value) {
    return typeof value === 'string' && value.trim() !== ''
}

// A legacy manifest names the shipped synthetic fixture it was built from; that one field resolves
// under the fixture directory, and every captured artefact resolves under the probe root.
const SYNTHETIC_FIXTURE_ROOT = 'fixtures/harness-probes'

function resolveEvidencePath(root, value, field, errors, allowedRoot = PROBE_EVIDENCE_ROOT) {
    if (!isText(value)) return null
    if (isAbsolute(value)) {
        errors.push(`${field} must be relative to the repository root`)
        return null
    }
    const repositoryRoot = resolve(root)
    const absolute = resolve(repositoryRoot, value)
    const fromRoot = relative(repositoryRoot, absolute)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
        errors.push(`${field} escapes the repository root`)
        return null
    }
    const path = fromRoot.split(sep).join('/')
    if (!path.startsWith(`${allowedRoot}/`)) {
        errors.push(`${field} must be under ${allowedRoot}/`)
        return null
    }
    if (!existsSync(absolute)) {
        errors.push(`${field} does not exist: ${value}`)
        return null
    }
    if (!statSync(absolute).isFile()) {
        errors.push(`${field} must name a file: ${value}`)
        return null
    }
    const canonicalRoot = realpathSync(repositoryRoot)
    const canonicalPath = realpathSync(absolute)
    const canonicalRelative = relative(canonicalRoot, canonicalPath)
    if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`)) {
        errors.push(`${field} resolves outside the repository root`)
        return null
    }
    return absolute
}

function isProbeEvidencePath(root, value) {
    if (!isText(value) || isAbsolute(value)) return false
    const unresolvedProbeRoot = resolve(root, PROBE_EVIDENCE_ROOT)
    if (!existsSync(unresolvedProbeRoot)) return false
    const probeRoot = realpathSync(unresolvedProbeRoot)
    const canonicalPath = realpathSync(resolve(root, value))
    const path = relative(probeRoot, canonicalPath)
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`)
}

function textSha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateCommand(value, name, errors, controlPlaceholder = false, native = false) {
    if (!Array.isArray(value) || value.length === 0) {
        errors.push(`${name} must be a non-empty argv array`)
        return null
    }
    if (value.length > LEGACY_COMMAND_MAX_ARGUMENTS) {
        errors.push(`${name} exceeds its argv bound`)
        return null
    }
    let bytes = 0
    for (const argument of value) {
        if (!isText(argument) && !(native && argument === '')) {
            errors.push(`${name} must be a non-empty argv array`)
            return null
        }
        bytes += Buffer.byteLength(argument)
        if (bytes > LEGACY_COMMAND_MAX_BYTES) {
            errors.push(`${name} exceeds its argv bound`)
            return null
        }
    }
    const placeholderCount = value.filter((argument) => argument === '{control}').length
    if (controlPlaceholder && placeholderCount !== 1) {
        errors.push(`${name} must contain exactly one {control} argument`)
    }
    if (!controlPlaceholder && placeholderCount !== 0) {
        errors.push(`${name} must not contain a {control} argument`)
    }
    return value
}

function canonicalExecutable(command, name, errors) {
    if (!Array.isArray(command) || command.length === 0) return null
    const executable = command[0]
    if (!isAbsolute(executable)) {
        errors.push(`${name} executable must use an absolute path`)
        return null
    }
    if (!existsSync(executable) || !statSync(executable).isFile()) {
        errors.push(`${name} executable does not name a file`)
        return null
    }
    return realpathSync(executable)
}

function canonicalToolCommand(command, name, errors) {
    const executable = canonicalExecutable(command, name, errors)
    if (!executable) return null
    const executableName = basename(executable).toLowerCase()
    const versionedInterpreter = /^(?:node(?:js)?|perl|php|python|ruby)\d+(?:\.\d+)*$/.test(executableName)
    if (GENERIC_COMMAND_LAUNCHERS.has(executableName) || versionedInterpreter) {
        errors.push(`${name} must invoke the harness binary directly; ${executableName} is a generic command launcher`)
        return null
    }
    return [executable]
}

function executableOnPath(name) {
    for (const directory of (process.env.PATH ?? '').split(':')) {
        if (!directory) continue
        const candidate = resolve(directory, name)
        if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate)
    }
    return null
}

function validateHarnessExecutable(harness, command, errors, options, allowLivePathIdentity = true) {
    if (!HARNESSES.includes(harness) || !Array.isArray(command) || command.length === 0) return
    const canonical = canonicalExecutable(command, 'invocation', [])
    if (!canonical) return
    const commandName = basename(command[0]).toLowerCase()
    const liveIdentity = allowLivePathIdentity && HARNESS_EXECUTABLE_IDENTITIES[harness].some(
        (name) => commandName === name && executableOnPath(name) === canonical,
    )
    const injectedIdentities = process.env.NODE_ENV === 'test'
        ? options?.testOnlyExecutableIdentities?.[harness]
        : undefined
    const injectedIdentity = Array.isArray(injectedIdentities) && injectedIdentities.some((path) => {
        if (!isText(path) || !isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) return false
        return realpathSync(path) === canonical
    })
    const operatorIdentities = options?.operatorExecutableIdentities
    const operatorIdentity = operatorIdentities instanceof Map && (() => {
        const identity = operatorIdentities.get(harness)
        return isRecord(identity) && exactKeys(identity, ['canonicalPath', 'sha256'])
            && isText(identity.canonicalPath) && isAbsolute(identity.canonicalPath)
            && SELFTEST_DIGEST.test(identity.sha256 ?? '')
            && existsSync(identity.canonicalPath) && statSync(identity.canonicalPath).isFile()
            && realpathSync(identity.canonicalPath) === canonical
            && hashHarnessExecutable(canonical, errors) === identity.sha256
    })()
    if (!liveIdentity && !injectedIdentity && !operatorIdentity) {
        errors.push(`${harness} evidence must invoke its harness executable directly`)
    }
}

function resolveEventCwd(root, value, name, errors) {
    if (!isText(value)) return null
    if (isAbsolute(value)) {
        errors.push(`${name}.cwd must be relative to the repository root`)
        return null
    }
    const repositoryRoot = realpathSync(resolve(root))
    const absolute = resolve(repositoryRoot, value)
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        errors.push(`${name}.cwd does not name a directory`)
        return null
    }
    const canonical = realpathSync(absolute)
    const fromRoot = relative(repositoryRoot, canonical)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
        errors.push(`${name}.cwd resolves outside the repository root`)
        return null
    }
    return canonical
}

function validateEvent(value, name, errors) {
    if (!isRecord(value)) {
        errors.push(`${name} must be a structured event`)
        return null
    }
    const command = validateCommand(value.command, `${name}.command`, errors)
    for (const field of ['cwd', 'stream', 'code', 'result', 'output', 'outputSha256']) {
        if (!isText(value[field])) errors.push(`${name}.${field} must be a non-empty string`)
    }
    const outputBounded = isText(value.output) && Buffer.byteLength(value.output) <= LEGACY_TEXT_MAX_BYTES
    if (isText(value.output) && !outputBounded) {
        errors.push(`${name}.output exceeds the ${LEGACY_TEXT_MAX_BYTES}-byte limit`)
    }
    if (!Number.isInteger(value.exitCode) || value.exitCode < 0) {
        errors.push(`${name}.exitCode must be a non-negative integer`)
    }
    if (!['stdout', 'stderr'].includes(value.stream)) errors.push(`${name}.stream must be stdout or stderr`)
    if (!EVENT_RESULTS.includes(value.result)) errors.push(`${name}.result is unknown`)
    if (isText(value.code) && !/^[A-Z][A-Z0-9_]*$/.test(value.code)) {
        errors.push(`${name}.code must be an uppercase diagnostic code`)
    }
    if (isText(value.outputSha256) && !/^[a-f0-9]{64}$/.test(value.outputSha256)) {
        errors.push(`${name}.outputSha256 must be a lowercase SHA-256 digest`)
    } else if (outputBounded && isText(value.outputSha256) && textSha256(value.output) !== value.outputSha256) {
        errors.push(`${name}.outputSha256 does not match its output`)
    }
    if (
        isText(value.code) &&
        isText(value.output) &&
        !value.output.split(/\r?\n/).some((line) => line.trim() === value.code)
    ) {
        const evidence = name === 'brokenControl' || name === 'candidateControl' ? 'refusal' : 'event'
        errors.push(`${name} output does not contain its exact ${evidence} code`)
    }
    return { ...value, command }
}

export function validateEvidenceManifest(manifest, root = process.cwd(), options = undefined) {
    const errors = []
    const captured = captureSelftestData(manifest, 'manifest', errors)
    if (!isRecord(captured)) return [...errors, 'manifest must be an object']
    manifest = captured

    for (const field of REQUIRED_TEXT) {
        if (!isText(manifest[field])) errors.push(`${field} must be a non-empty string`)
        else if (Buffer.byteLength(manifest[field]) > LEGACY_TEXT_MAX_BYTES) {
            errors.push(`${field} exceeds the ${LEGACY_TEXT_MAX_BYTES}-byte limit`)
        }
    }
    if (!HARNESSES.includes(manifest.harness)) errors.push(`unknown harness: ${String(manifest.harness)}`)
    if (!CAPABILITIES.includes(manifest.capability)) errors.push(`unknown capability: ${String(manifest.capability)}`)
    if (!VERDICTS.includes(manifest.verdict)) errors.push(`unknown verdict: ${String(manifest.verdict)}`)
    if (typeof manifest.brokenRejected !== 'boolean') errors.push('brokenRejected must be a boolean')
    if (isText(manifest.date) && !/^\d{4}-\d{2}-\d{2}$/.test(manifest.date)) errors.push('date must use YYYY-MM-DD')
    const versionCommand = validateCommand(manifest.versionCommand, 'versionCommand', errors)
    const helpCommand = validateCommand(manifest.helpCommand, 'helpCommand', errors)
    const invocation = validateCommand(manifest.invocation, 'invocation', errors, true)
    const toolCommands = [
        canonicalToolCommand(versionCommand, 'versionCommand', errors),
        canonicalToolCommand(helpCommand, 'helpCommand', errors),
        canonicalToolCommand(invocation, 'invocation', errors),
    ].filter(Boolean)
    validateHarnessExecutable(manifest.harness, invocation, errors, options)
    if (new Set(toolCommands.map((command) => JSON.stringify(command))).size > 1) {
        errors.push('version, help and shared invocation tool commands must match')
    }
    if (versionCommand && invocation && versionCommand[0] !== invocation[0]) {
        errors.push('versionCommand executable does not match the shared invocation template')
    }
    if (helpCommand && invocation && helpCommand[0] !== invocation[0]) {
        errors.push('helpCommand executable does not match the shared invocation template')
    }
    if (
        versionCommand &&
        invocation &&
        !isDeepStrictEqual(
            canonicalToolCommand(versionCommand, 'versionCommand', []),
            canonicalToolCommand(invocation, 'invocation', []),
        )
    ) {
        errors.push('versionCommand tool command does not match the shared invocation template')
    }
    if (
        helpCommand &&
        invocation &&
        !isDeepStrictEqual(
            canonicalToolCommand(helpCommand, 'helpCommand', []),
            canonicalToolCommand(invocation, 'invocation', []),
        )
    ) {
        errors.push('helpCommand tool command does not match the shared invocation template')
    }

    const candidatePath = resolveEvidencePath(root, manifest.candidatePath, 'candidatePath', errors)
    const brokenPath = resolveEvidencePath(root, manifest.brokenPath, 'brokenPath', errors)
    const transcriptPath = resolveEvidencePath(root, manifest.transcriptPath, 'transcriptPath', errors)
    const syntheticFixture = resolveEvidencePath(root, manifest.syntheticFixture, 'syntheticFixture', errors, SYNTHETIC_FIXTURE_ROOT)
    const candidateBytes = candidatePath
        ? readBoundedSelftestFile(candidatePath, LEGACY_EVIDENCE_MAX_BYTES, 'candidatePath', errors) : null
    const brokenBytes = brokenPath
        ? readBoundedSelftestFile(brokenPath, LEGACY_EVIDENCE_MAX_BYTES, 'brokenPath', errors) : null
    const transcriptBytes = transcriptPath
        ? readBoundedSelftestFile(transcriptPath, LEGACY_EVIDENCE_MAX_BYTES, 'transcriptPath', errors) : null

    if (isText(manifest.candidatePath) && isText(manifest.brokenPath)) {
        if (manifest.candidatePath === manifest.brokenPath) errors.push('candidatePath and brokenPath must be distinct')
        if (dirname(manifest.candidatePath) !== dirname(manifest.brokenPath)) errors.push('candidatePath and brokenPath must be colocated')
    }
    if (
        isText(manifest.candidatePath) &&
        isText(manifest.brokenPath) &&
        isText(manifest.transcriptPath) &&
        (dirname(manifest.candidatePath) !== dirname(manifest.transcriptPath) ||
            dirname(manifest.brokenPath) !== dirname(manifest.transcriptPath))
    ) {
        errors.push('candidatePath, brokenPath and transcriptPath must be colocated')
    }
    if (
        candidatePath &&
        brokenPath &&
        transcriptPath &&
        new Set([candidatePath, brokenPath, transcriptPath].map((path) => dirname(realpathSync(path)))).size !== 1
    ) {
        errors.push('candidatePath, brokenPath and transcriptPath must resolve to one directory')
    }
    if (syntheticFixture) {
        const fixtureRelative = relative(realpathSync(resolve(root, SYNTHETIC_FIXTURE_ROOT)), realpathSync(syntheticFixture))
        if (fixtureRelative === '' || fixtureRelative === '..' || fixtureRelative.startsWith(`..${sep}`)) {
            errors.push(`syntheticFixture must be a file under ${SYNTHETIC_FIXTURE_ROOT}/`)
        }
    }

    if (candidateBytes && brokenBytes
        && createHash('sha256').update(candidateBytes).digest('hex') === createHash('sha256').update(brokenBytes).digest('hex')) {
        errors.push('candidatePath and brokenPath must have distinct content')
    }

    const events = isRecord(manifest.events) ? manifest.events : null
    if (!events) errors.push('events must be an object')
    const validatedEvents = Object.fromEntries(
        EVENT_NAMES.map((name) => [name, validateEvent(events?.[name], name, errors)]),
    )
    const eventCwds = Object.fromEntries(
        EVENT_NAMES.map((name) => [name, resolveEventCwd(root, validatedEvents[name]?.cwd, name, errors)]),
    )
    const eventToolCommands = EVENT_NAMES.map((name) =>
        canonicalToolCommand(validatedEvents[name]?.command, `${name}.command`, errors),
    ).filter(Boolean)
    if (new Set([...toolCommands, ...eventToolCommands].map((command) => JSON.stringify(command))).size > 1) {
        errors.push('every event must use the shared invocation tool command')
    }
    for (const name of EVENT_NAMES) {
        const event = validatedEvents[name]
        if (!event || !EVENT_RESULTS.includes(event.result) || !Number.isInteger(event.exitCode)) continue
        if (ZERO_EXIT_RESULTS.includes(event.result) && event.exitCode !== 0) {
            errors.push(`${name} ${event.result} result requires exitCode=0`)
        }
        if (!ZERO_EXIT_RESULTS.includes(event.result) && event.exitCode === 0) {
            errors.push(`${name} ${event.result} result requires a non-zero exitCode`)
        }
    }
    if (validatedEvents.brokenControl && typeof manifest.brokenRejected === 'boolean') {
        const brokenRejected =
            validatedEvents.brokenControl.result === 'rejected' && validatedEvents.brokenControl.exitCode !== 0
        if (manifest.brokenRejected !== brokenRejected) {
            errors.push('brokenRejected does not match the brokenControl result and exitCode')
        }
    }

    if (validatedEvents.version && versionCommand && !isDeepStrictEqual(validatedEvents.version.command, versionCommand)) {
        errors.push('version event command does not match versionCommand')
    }
    if (validatedEvents.help && helpCommand && !isDeepStrictEqual(validatedEvents.help.command, helpCommand)) {
        errors.push('help event command does not match helpCommand')
    }
    if (validatedEvents.version && (validatedEvents.version.exitCode !== 0 || validatedEvents.version.result !== 'completed')) {
        errors.push('version event must complete successfully')
    }
    if (validatedEvents.help && (validatedEvents.help.exitCode !== 0 || validatedEvents.help.result !== 'completed')) {
        errors.push('help event must complete successfully')
    }
    if (
        validatedEvents.version &&
        isText(manifest.version) &&
        isText(validatedEvents.version.output) &&
        !validatedEvents.version.output.split(/\s+/).includes(manifest.version)
    ) {
        errors.push('version event output does not contain the declared harness version')
    }
    if (invocation && candidatePath && brokenPath) {
        for (const [name, path] of [
            ['candidateControl', candidatePath],
            ['brokenControl', brokenPath],
        ]) {
            const event = validatedEvents[name]
            const expected = invocation.map((argument) =>
                argument === '{control}' ? relative(realpathSync(resolve(root)), realpathSync(path)).split(sep).join('/') : argument,
            )
            if (event && !isDeepStrictEqual(event.command, expected)) {
                errors.push(`${name} command does not match the shared invocation template`)
            }
            const placeholderIndex = invocation.indexOf('{control}')
            const cwd = eventCwds[name]
            const argument = event?.command?.[placeholderIndex]
            if (cwd && isText(argument)) {
                const addressed = resolve(cwd, argument)
                if (!existsSync(addressed) || realpathSync(addressed) !== realpathSync(path)) {
                    errors.push(`${name} command does not resolve to ${name === 'brokenControl' ? 'brokenPath' : 'candidatePath'} from its cwd`)
                }
            }
        }
    }
    if (
        validatedEvents.brokenControl &&
        brokenPath &&
        !`${validatedEvents.brokenControl.command}\n${validatedEvents.brokenControl.output}`.includes(basename(brokenPath))
    ) {
        errors.push('brokenControl event does not name the broken control')
    }
    if (
        validatedEvents.candidateControl &&
        candidatePath &&
        !`${validatedEvents.candidateControl.command}\n${validatedEvents.candidateControl.output}`.includes(basename(candidatePath))
    ) {
        errors.push('candidateControl event does not name the candidate control')
    }

    for (const [field, bytes] of [
        ['candidateSha256', candidateBytes],
        ['brokenSha256', brokenBytes],
        ['transcriptSha256', transcriptBytes],
    ]) {
        if (isText(manifest[field]) && !/^[a-f0-9]{64}$/.test(manifest[field])) {
            errors.push(`${field} must be a lowercase SHA-256 digest`)
        } else if (bytes && isText(manifest[field]) && createHash('sha256').update(bytes).digest('hex') !== manifest[field]) {
            errors.push(`${field} does not match ${field.replace('Sha256', 'Path')}`)
        }
    }

    if (transcriptBytes) {
        let transcript
        try {
            transcript = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(transcriptBytes))
        } catch (error) {
            errors.push(`transcript must be structured JSON evidence: ${errorCause(error)}`)
        }
        const expectedTranscript = {
            harness: manifest.harness,
            version: manifest.version,
            date: manifest.date,
            capability: manifest.capability,
            runId: manifest.runId,
            forbiddenAction: manifest.forbiddenAction,
            verdict: manifest.verdict,
            invocation: manifest.invocation,
            events: manifest.events,
        }
        if (transcript && !isDeepStrictEqual(transcript, expectedTranscript)) {
            errors.push('transcript does not match the structured run evidence')
        }
    }

    if (
        !candidatePath ||
        !brokenPath ||
        !transcriptPath ||
        ![manifest.candidatePath, manifest.brokenPath, manifest.transcriptPath].every((path) =>
            isProbeEvidencePath(root, path),
        )
    ) {
        errors.push(`every verdict requires candidatePath, brokenPath and transcriptPath under ${PROBE_EVIDENCE_ROOT}/`)
    }
    const brokenWasRejected =
        manifest.brokenRejected === true &&
        validatedEvents.brokenControl?.result === 'rejected' &&
        validatedEvents.brokenControl?.exitCode !== 0
    if (!brokenWasRejected) {
        errors.push('every verdict requires a non-zero rejected brokenControl event')
    }
    if (manifest.verdict === 'enforced') {
        if (validatedEvents.candidateControl?.result !== 'refused' || validatedEvents.candidateControl?.exitCode === 0) {
            errors.push('enforced verdict requires a non-zero refused candidateControl event')
        }
    }
    if (
        manifest.verdict === 'unavailable' &&
        validatedEvents.candidateControl &&
        !['allowed', 'unavailable'].includes(validatedEvents.candidateControl.result)
    ) {
        errors.push('unavailable verdict requires an allowed or unavailable candidateControl event')
    }
    return errors
}

const SELFTEST_CAPABILITIES = ['instruction-loading', 'guard-firing', 'skill-parity']
const SELFTEST_VERDICTS = ['enforced', 'instructed', 'unavailable']
const SELFTEST_HUMAN_REASONS = ['executable_missing', 'authentication_required', 'isolation_unavailable', 'enforcement_probe_required', 'native_protocol_unsupported']
const SELFTEST_SAMPLE_FEATURES = ['name', 'trigger', 'body-load', 'tools', 'non-goals']
const SELFTEST_EVENT_RESULTS = ['completed', 'rejected', 'accepted', 'refused', 'allowed', 'unavailable']
const SELFTEST_ZERO_EXIT_RESULTS = ['completed', 'accepted', 'allowed']
const SELFTEST_SIGNALS = new Set([
    'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO',
    'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT',
    'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1',
    'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ', 'SIGBREAK', 'SIGLOST', 'SIGINFO',
])
const BUILTIN_SELFTEST_HARNESSES = Object.freeze({
    claudecode: 'Claude Code', codexcli: 'Codex', opencode: 'OpenCode',
})
const SELFTEST_MAX_ROWS = 256
const SELFTEST_MAX_BUNDLE_BYTES = 4_194_304
const SELFTEST_MAX_STREAM_BYTES = 65_536
export const NATIVE_SELFTEST_STREAM_BYTES = 1_048_576
const SELFTEST_MAX_TEXT_BYTES = 4_096
const SELFTEST_DIGEST = /^[a-f0-9]{64}$/
const SELFTEST_CUSTOM_ID = /^(?!(?:claudecode|codexcli|opencode)$)[a-z0-9][a-z0-9-]{0,127}$/
const SELFTEST_EXPORT = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/
const SELFTEST_CODE = /^[A-Z][A-Z0-9_]*$/
const SELFTEST_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/

function jsonStringBytes(value) {
    let bytes = 2
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index)
        if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
            || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2
        else if (code < 0x20 || code >= 0xd800 && code <= 0xdfff) {
            if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
                const low = value.charCodeAt(index + 1)
                if (low >= 0xdc00 && low <= 0xdfff) {
                    bytes += 4
                    index += 1
                    continue
                }
            }
            bytes += 6
        } else if (code <= 0x7f) bytes += 1
        else if (code <= 0x7ff) bytes += 2
        else bytes += 3
    }
    return bytes
}

function capturedArrayLimit(path) {
    if (path === 'bundle.skillReviews') return SELFTEST_MAX_ROWS * 2
    if (['bundle.records', 'bundle.skillInventory', 'expectation.cells', 'expectation.shippedSkills'].includes(path)) {
        return SELFTEST_MAX_ROWS
    }
    return SELFTEST_MAX_ROWS
}

function captureSelftestData(value, label, errors) {
    const state = { bytes: 0, seen: new WeakSet() }
    const add = amount => {
        state.bytes += amount
        return state.bytes <= SELFTEST_MAX_BUNDLE_BYTES
    }
    const visit = (current, path, depth) => {
        if (depth > 64 || utilTypes.isProxy(current)) return undefined
        if (current === null) return add(4) ? null : undefined
        if (typeof current === 'string') return add(jsonStringBytes(current)) ? current : undefined
        if (typeof current === 'boolean') return add(current ? 4 : 5) ? current : undefined
        if (typeof current === 'number' && Number.isFinite(current)) {
            const rendered = String(current === 0 ? 0 : current)
            return add(Buffer.byteLength(rendered)) ? current : undefined
        }
        if (typeof current !== 'object' || state.seen.has(current)) return undefined
        const prototype = Object.getPrototypeOf(current)
        if (Array.isArray(current)) {
            if (prototype !== Array.prototype) return undefined
            const lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length')
            const limit = capturedArrayLimit(path)
            if (!lengthDescriptor || !Number.isInteger(lengthDescriptor.value) || lengthDescriptor.value > limit) return undefined
            const length = lengthDescriptor.value
            const keys = Reflect.ownKeys(current)
            if (keys.some(key => typeof key !== 'string') || keys.length !== length + 1) return undefined
            state.seen.add(current)
            if (!add(2 + Math.max(0, length - 1))) return undefined
            const captured = []
            for (let index = 0; index < length; index += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
                if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return undefined
                const item = visit(descriptor.value, `${path}[${index}]`, depth + 1)
                if (item === undefined) return undefined
                captured.push(item)
            }
            state.seen.delete(current)
            return Object.freeze(captured)
        }
        if (prototype !== Object.prototype && prototype !== null) return undefined
        const keys = Reflect.ownKeys(current)
        if (keys.length > SELFTEST_MAX_ROWS || keys.some(key => typeof key !== 'string')) return undefined
        state.seen.add(current)
        if (!add(2 + Math.max(0, keys.length - 1))) return undefined
        const captured = {}
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(current, key)
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set
                || !add(jsonStringBytes(key) + 1)) return undefined
            const item = visit(descriptor.value, `${path}.${key}`, depth + 1)
            if (item === undefined) return undefined
            Object.defineProperty(captured, key, { value: item, enumerable: true })
        }
        state.seen.delete(current)
        return Object.freeze(captured)
    }
    const captured = visit(value, label, 0)
    if (captured === undefined) errors.push(`${label} must contain only bounded own data`)
    return captured
}

function sameFileObservation(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size
        && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function hashHarnessExecutable(path, errors) {
    let descriptor
    try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const before = fstatSync(descriptor, { bigint: true })
        const pathBefore = statSync(path, { bigint: true })
        if (!before.isFile() || !sameFileObservation(before, pathBefore) || realpathSync(path) !== path) {
            errors.push('harness executable changed before its bounded hash')
            return null
        }
        if (before.size > BigInt(HARNESS_EXECUTABLE_MAX_BYTES)) {
            errors.push(`harness executable exceeds the ${HARNESS_EXECUTABLE_MAX_BYTES}-byte limit`)
            return null
        }
        const buffer = Buffer.alloc(65_536)
        const hash = createHash('sha256')
        const size = Number(before.size)
        let offset = 0
        while (offset < size) {
            const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset)
            if (count === 0) break
            hash.update(buffer.subarray(0, count))
            offset += count
        }
        const after = fstatSync(descriptor, { bigint: true })
        const pathAfter = statSync(path, { bigint: true })
        if (offset !== size || !sameFileObservation(before, after) || !sameFileObservation(after, pathAfter)
            || realpathSync(path) !== path) {
            errors.push('harness executable changed during its bounded hash')
            return null
        }
        return hash.digest('hex')
    } catch (error) {
        errors.push(`harness executable could not be hashed: ${error instanceof Error ? error.message : String(error)}`)
        return null
    } finally {
        if (descriptor !== undefined) {
            try { closeSync(descriptor) } catch (error) {
                errors.push(`harness executable could not close its bounded hasher: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
    }
}

function readBoundedSelftestFile(path, limit, name, errors) {
    let descriptor
    try {
        const canonicalPath = realpathSync(path)
        descriptor = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const before = fstatSync(descriptor, { bigint: true })
        const pathBefore = statSync(path, { bigint: true })
        if (!before.isFile() || !sameFileObservation(before, pathBefore) || realpathSync(path) !== canonicalPath) {
            errors.push(`${name} changed before its bounded read`)
            return null
        }
        if (before.size > BigInt(limit)) {
            errors.push(`${name} exceeds the ${limit}-byte limit`)
            return null
        }
        const bytes = Buffer.alloc(Number(before.size))
        let offset = 0
        while (offset < bytes.length) {
            const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
            if (count === 0) break
            offset += count
        }
        const after = fstatSync(descriptor, { bigint: true })
        const pathAfter = statSync(path, { bigint: true })
        if (offset !== bytes.length || !sameFileObservation(before, after) || !sameFileObservation(after, pathAfter)
            || realpathSync(path) !== canonicalPath) {
            errors.push(`${name} changed during its bounded read`)
            return null
        }
        return bytes
    } catch (error) {
        errors.push(`${name} could not be read: ${error instanceof Error ? error.message : String(error)}`)
        return null
    } finally {
        if (descriptor !== undefined) {
            try { closeSync(descriptor) } catch (error) {
                errors.push(`${name} could not close its bounded reader: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
    }
}

function exactKeys(value, keys) {
    return isRecord(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
}

function boundedText(value, max = SELFTEST_MAX_TEXT_BYTES) {
    return isText(value) && Buffer.byteLength(value) <= max
}

function canonicalInstant(value) {
    if (!isText(value)) return null
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null
}

function canonicalDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false
    const time = Date.parse(`${value}T00:00:00.000Z`)
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

function validateSelftestHarness(value, name, errors) {
    if (!isRecord(value)) {
        errors.push(`${name} must be a harness reference`)
        return null
    }
    if (value.kind === 'builtin') {
        if (!exactKeys(value, ['kind', 'target', 'name'])) errors.push(`${name} has unknown built-in harness fields`)
        if (!Object.hasOwn(BUILTIN_SELFTEST_HARNESSES, value.target)
            || BUILTIN_SELFTEST_HARNESSES[value.target] !== value.name) {
            errors.push(`${name} is not a known built-in harness`)
            return null
        }
        return `builtin:${value.target}`
    }
    if (value.kind === 'custom') {
        if (!exactKeys(value, ['kind', 'id', 'declarationSha256', 'module', 'sourceSha256', 'export'])) {
            errors.push(`${name} has unknown custom harness fields`)
        }
        if (!isText(value.id) || !SELFTEST_CUSTOM_ID.test(value.id)) errors.push(`${name}.id is invalid`)
        for (const field of ['declarationSha256', 'sourceSha256']) {
            if (!isText(value[field]) || !SELFTEST_DIGEST.test(value[field])) errors.push(`${name}.${field} must be a lowercase SHA-256 digest`)
        }
        // Mirrors reservedPathSegment in surfaces/contract.ts; this standalone module cannot import it.
        const moduleSegments = isText(value.module) ? value.module.split('/') : []
        if (!isText(value.module) || Buffer.byteLength(value.module) > 4_096 || isAbsolute(value.module)
            || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value.module) || value.module.includes('\\')
            || /[\x00-\x1f\x7f]/.test(value.module)
            || moduleSegments.some(segment => segment === '' || segment === '.' || segment === '..'
                || ['.GIT', 'NODE_MODULES'].includes(segment.normalize('NFC').toUpperCase()))) {
            errors.push(`${name}.module must be a confined relative path`)
        }
        if (!isText(value.export) || !SELFTEST_EXPORT.test(value.export)) errors.push(`${name}.export is invalid`)
        return isText(value.id) ? `custom:${value.id}` : null
    }
    errors.push(`${name}.kind is unknown`)
    return null
}

function selftestCell(value, name, errors, exact = true) {
    if (!isRecord(value) || !Object.hasOwn(value, 'harness') || !Object.hasOwn(value, 'capability')) {
        errors.push(`${name} must contain harness and capability`)
        return null
    }
    const harness = validateSelftestHarness(value.harness, `${name}.harness`, errors)
    if (!SELFTEST_CAPABILITIES.includes(value.capability)) {
        errors.push(`unknown selftest capability: ${String(value.capability)}`)
        return null
    }
    if (value.capability === 'skill-parity') {
        if (exact && !exactKeys(value, ['harness', 'capability', 'skill'])) {
            errors.push(`${name} skill-parity cell must contain exactly harness, capability, and skill`)
        }
        const skill = exact ? value.skill : value.kind === 'evidence' ? value.sample?.skill : value.skill
        if (!boundedText(skill, 128) || !SELFTEST_SKILL_NAME.test(skill)) {
            errors.push(`${name}.skill must be a bounded skill name`)
            return null
        }
        return harness ? `${harness}/${value.capability}/${skill}` : null
    }
    if (exact && !exactKeys(value, ['harness', 'capability'])) {
        errors.push(`${name} must contain exactly harness and capability`)
    }
    return harness ? `${harness}/${value.capability}` : null
}

function validateSelftestExpectation(expectation, errors) {
    if (!exactKeys(expectation, ['schema', 'generatedManifestSha256', 'cells', 'shippedSkills', 'reviewHarnesses',
        ...(expectation?.instructionSourceSha256 === undefined ? [] : ['instructionSourceSha256']),
        ...(expectation?.nativeSourceSha256 === undefined ? [] : ['nativeSourceSha256']),
        ...(expectation?.guardProbeHost === undefined ? [] : ['guardProbeHost']),
        ...(expectation?.guardHookCommand === undefined ? [] : ['guardHookCommand'])])) {
        errors.push('expectation must contain only the versioned authority fields')
        return { cells: [], cellKeys: [], skills: [], reviews: [] }
    }
    if (expectation.schema !== 'cockpit-harness-selftest-expectation/v1') errors.push('unknown selftest expectation schema')
    if (!SELFTEST_DIGEST.test(expectation.generatedManifestSha256 ?? '')) {
        errors.push('expectation generatedManifestSha256 must be a lowercase SHA-256 digest')
    }
    if (expectation.instructionSourceSha256 !== undefined && !SELFTEST_DIGEST.test(expectation.instructionSourceSha256)) {
        errors.push('instructionSourceSha256 must be a lowercase SHA-256 digest')
    }
    if (expectation.nativeSourceSha256 !== undefined && (!isRecord(expectation.nativeSourceSha256)
        || Object.entries(expectation.nativeSourceSha256).some(([path, digest]) =>
            !/^(?:AGENTS\.md|CLAUDE\.md|\.claude\/settings\.json|\.(?:agents|claude)\/skills\/[a-z0-9][a-z0-9-]{0,127}\/SKILL\.md)$/.test(path)
            || typeof digest !== 'string' || !SELFTEST_DIGEST.test(digest)))) errors.push('native source authority must contain only bounded generated source paths and digests')
    if (expectation.guardProbeHost !== undefined && (typeof expectation.guardProbeHost !== 'string' || expectation.guardProbeHost.length > 253
        || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(expectation.guardProbeHost))) errors.push('guard probe host must be a bounded DNS hostname')
    if (expectation.guardHookCommand !== undefined && !validNativeGuardHookCommand(expectation.guardHookCommand)) errors.push('guard hook command must be bounded text')
    const cells = Array.isArray(expectation.cells) ? expectation.cells : []
    if (cells.length === 0 || cells.length > SELFTEST_MAX_ROWS) errors.push('expectation cells must contain between 1 and 256 rows')
    const cellKeys = cells.map((cell, index) => selftestCell(cell, `expectation cell ${index + 1}`, errors)).filter(Boolean)
    if (new Set(cellKeys).size !== cellKeys.length) errors.push('expectation cells must be unique')
    const skills = Array.isArray(expectation.shippedSkills) ? expectation.shippedSkills : []
    if (skills.length === 0 || skills.length > SELFTEST_MAX_ROWS
        || skills.some(skill => !boundedText(skill, 128) || !SELFTEST_SKILL_NAME.test(skill))) {
        errors.push('expectation shippedSkills must contain between 1 and 256 bounded names')
    }
    if (new Set(skills).size !== skills.length) errors.push('expectation shippedSkills must be unique')
    const reviews = expectation.reviewHarnesses
    if (!Array.isArray(reviews) || reviews.length !== 2
        || !exactKeys(reviews[0], ['name', 'nativeDiagnostics'])
        || !exactKeys(reviews[1], ['name', 'nativeDiagnostics'])
        || reviews[0].name !== 'Claude Code' || reviews[1].name !== 'Codex'
        || typeof reviews[0].nativeDiagnostics !== 'boolean' || typeof reviews[1].nativeDiagnostics !== 'boolean') {
        errors.push('expectation reviewHarnesses must be exactly Claude Code then Codex')
    }
    return { cells, cellKeys, skills, reviews: Array.isArray(reviews) ? reviews : [] }
}

function validateSelftestEvent(value, name, errors, native = false, guard = false) {
    const fields = ['cwd', 'command', 'exitCode', 'signal', 'result', 'code', 'stdout', 'stderr', 'stdoutSha256', 'stderrSha256']
    if (!exactKeys(value, fields)) {
        errors.push(`${name} must contain exactly the structured event fields`)
        return null
    }
    const command = validateCommand(value.command, `${name}.command`, errors, false, native)
    if (!isText(value.cwd)) errors.push(`${name}.cwd must be a non-empty string`)
    if (!Number.isInteger(value.exitCode) || value.exitCode < 0) errors.push(`${name}.exitCode must be a non-negative integer`)
    if (value.signal !== null && !SELFTEST_SIGNALS.has(value.signal)) errors.push(`${name}.signal must be a Node signal or null`)
    if (!SELFTEST_EVENT_RESULTS.includes(value.result)) errors.push(`${name}.result is unknown`)
    if (!isText(value.code) || !SELFTEST_CODE.test(value.code)) errors.push(`${name}.code must be an uppercase diagnostic code`)
    for (const stream of ['stdout', 'stderr']) {
        if (typeof value[stream] !== 'string' || Buffer.byteLength(value[stream]) > (native ? NATIVE_SELFTEST_STREAM_BYTES : SELFTEST_MAX_STREAM_BYTES)) {
            errors.push(`${name}.${stream} must be a string no larger than ${native ? NATIVE_SELFTEST_STREAM_BYTES : SELFTEST_MAX_STREAM_BYTES} bytes`)
        }
        const digest = value[`${stream}Sha256`]
        if (!isText(digest) || !SELFTEST_DIGEST.test(digest)) errors.push(`${name}.${stream}Sha256 must be a lowercase SHA-256 digest`)
        else if (typeof value[stream] === 'string' && textSha256(value[stream]) !== digest) errors.push(`${name}.${stream}Sha256 does not match ${stream}`)
    }
    if (name === 'version' && value.code !== 'VERSION_OK') errors.push('version event must carry VERSION_OK classification')
    if (name === 'help' && value.code !== 'HELP_OK') errors.push('help event must carry HELP_OK classification')
    if ((name === 'version' || name === 'help') && !`${value.stdout}${value.stderr}`.trim()) {
        errors.push(`${name} event must include actual command output`)
    }
    if (!native && name !== 'version' && name !== 'help' && isText(value.code)
        && !`${value.stdout}\n${value.stderr}`.split(/\r?\n/).some(line => line.trim() === value.code)) {
        errors.push(`${name} output does not contain its exact code`)
    }
    if (SELFTEST_ZERO_EXIT_RESULTS.includes(value.result) && value.exitCode !== 0) errors.push(`${name} ${value.result} result requires exitCode=0`)
    if (SELFTEST_ZERO_EXIT_RESULTS.includes(value.result) && value.signal !== null) errors.push(`${name} ${value.result} result requires signal=null`)
    if (SELFTEST_EVENT_RESULTS.includes(value.result) && !SELFTEST_ZERO_EXIT_RESULTS.includes(value.result) && value.exitCode === 0 && !(guard && name === 'candidateControl' && value.result === 'refused')) {
        errors.push(`${name} ${value.result} result requires a non-zero exitCode`)
    }
    return { ...value, command }
}

// Prompt-input is a native input dump, not an assistant response. Comparing the inherited prefix
// prevents an ancestor AGENTS.md from substituting for the leaf control under test.
export function validateNativeInstructionPair(candidateOutput, brokenOutput, candidateCwd, brokenCwd, candidateBytes, brokenBytes) {
    if ([candidateOutput, brokenOutput].some(value => typeof value !== 'string' || Buffer.byteLength(value) > NATIVE_SELFTEST_STREAM_BYTES)) return 'native prompt-input output exceeds its stream bound'
    const instructions = (output, cwd) => {
        let messages
        try { messages = JSON.parse(output) } catch { return null }
        if (!Array.isArray(messages)) return null
        const prefix = `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n`
        const suffix = '\n</INSTRUCTIONS>'
        const matches = messages.filter(message => message?.type === 'message' && message.role === 'user')
            .flatMap(message => Array.isArray(message.content) ? message.content : [])
            .filter(block => block?.type === 'input_text' && typeof block.text === 'string'
                && block.text.startsWith(prefix) && block.text.endsWith(suffix))
        return matches.length === 1 ? matches[0].text.slice(prefix.length, -suffix.length) : null
    }
    const candidate = instructions(candidateOutput, candidateCwd)
    const broken = instructions(brokenOutput, brokenCwd)
    if (!candidateBytes || candidateBytes === brokenBytes || !/^Cockpit selftest replacement control [a-f0-9]{24}\.\n$/.test(brokenBytes)
        || candidate === null || broken === null || !candidate.endsWith(candidateBytes) || !broken.endsWith(brokenBytes)
        || candidate.slice(0, -candidateBytes.length) !== broken.slice(0, -brokenBytes.length)) {
        return 'native prompt-input did not independently load the exact candidate and replacement instructions at their control paths, or the tool cut the candidate at its instruction size limit'
    }
    return null
}

function validateSelftestEvidence(record, expectedHarness, root, options, errors, expectation) {
    const guard = record.protocol === 'claude-guard-loopback/v1'
    const modelInput = MODEL_INPUT_PROTOCOLS.includes(record.protocol)
    const native = record.protocol === 'codex-prompt-input/v1' || modelInput || guard
    const fields = [
        'kind', 'harness', 'capability', 'generatedManifestSha256', 'verdict', 'version', 'measuredOn', 'runId',
        'startedAt', 'finishedAt', 'expiresAt', 'candidatePath', 'brokenPath', 'transcriptPath', 'candidateSha256',
        'brokenSha256', 'transcriptSha256', 'invocation', 'versionCommand', 'helpCommand', 'candidateCode',
        'brokenCode', 'sample', 'authority', 'events', ...(native ? ['protocol'] : []), ...(modelInput || guard ? ['modelInputs', 'modelEndpoints'] : []), ...(guard ? ['guardProbe'] : []),
    ]
    if (!exactKeys(record, fields)) errors.push('evidence record contains unknown or missing fields')
    for (const field of ['version', 'runId', 'candidateCode', 'brokenCode']) {
        if (!boundedText(record[field])) errors.push(`${field} must be bounded non-empty text`)
    }
    if (!SELFTEST_CODE.test(record.candidateCode ?? '')) errors.push('candidateCode must be an uppercase diagnostic code')
    if (!SELFTEST_CODE.test(record.brokenCode ?? '')) errors.push('brokenCode must be an uppercase diagnostic code')
    if (!SELFTEST_VERDICTS.includes(record.verdict)) errors.push(`unknown selftest verdict: ${String(record.verdict)}`)
    if (!SELFTEST_DIGEST.test(record.generatedManifestSha256 ?? '')) errors.push('generatedManifestSha256 must be a lowercase SHA-256 digest')

    const startedAt = canonicalInstant(record.startedAt)
    const finishedAt = canonicalInstant(record.finishedAt)
    const expiresAt = canonicalInstant(record.expiresAt)
    const nowValue = process.env.NODE_ENV === 'test' && options?.testOnlyNow ? options.testOnlyNow : new Date().toISOString()
    const now = canonicalInstant(nowValue)
    if (startedAt === null || finishedAt === null || expiresAt === null) errors.push('evidence timestamps must be canonical ISO instants')
    else {
        if (startedAt > finishedAt || finishedAt >= expiresAt) errors.push('evidence timestamps are out of order')
        if (expiresAt - startedAt > 300_000) errors.push('evidence expiry exceeds 300000ms')
        if (now === null || now >= expiresAt) errors.push('evidence has expired')
        if (record.measuredOn !== record.startedAt.slice(0, 10)) errors.push('measuredOn must equal the UTC date of startedAt')
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.measuredOn ?? '')) errors.push('measuredOn must use YYYY-MM-DD')

    const invocation = validateCommand(record.invocation, 'invocation', errors, !native || guard, native)
    const versionCommand = validateCommand(record.versionCommand, 'versionCommand', errors)
    const helpCommand = validateCommand(record.helpCommand, 'helpCommand', errors)
    const candidatePath = resolveEvidencePath(root, record.candidatePath, 'candidatePath', errors)
    const brokenPath = resolveEvidencePath(root, record.brokenPath, 'brokenPath', errors)
    const transcriptPath = resolveEvidencePath(root, record.transcriptPath, 'transcriptPath', errors)
    const candidateBytes = candidatePath
        ? readBoundedSelftestFile(candidatePath, SELFTEST_MAX_STREAM_BYTES, 'candidatePath', errors) : null
    const brokenBytes = brokenPath
        ? readBoundedSelftestFile(brokenPath, SELFTEST_MAX_STREAM_BYTES, 'brokenPath', errors) : null
    const transcriptBytes = transcriptPath
        ? readBoundedSelftestFile(transcriptPath, SELFTEST_MAX_BUNDLE_BYTES, 'transcriptPath', errors) : null
    if (candidatePath && brokenPath && transcriptPath) {
        if (![record.candidatePath, record.brokenPath, record.transcriptPath].every(path => isProbeEvidencePath(root, path))) {
            errors.push(`evidence paths must remain under ${PROBE_EVIDENCE_ROOT}/`)
        }
        if (!native && new Set([candidatePath, brokenPath, transcriptPath].map(path => dirname(realpathSync(path)))).size !== 1) {
            errors.push('candidate, broken control, and transcript must be colocated')
        }
        if (realpathSync(candidatePath) === realpathSync(brokenPath)
            || candidateBytes && brokenBytes && textSha256(candidateBytes) === textSha256(brokenBytes)) {
            errors.push('candidate and broken control must be distinct')
        }
    }
    for (const [field, bytes] of [
        ['candidateSha256', candidateBytes], ['brokenSha256', brokenBytes], ['transcriptSha256', transcriptBytes],
    ]) {
        if (!SELFTEST_DIGEST.test(record[field] ?? '')) errors.push(`${field} must be a lowercase SHA-256 digest`)
        else if (bytes && textSha256(bytes) !== record[field]) errors.push(`${field} does not match its evidence file`)
    }

    const events = isRecord(record.events) ? record.events : null
    if (!events || !exactKeys(events, ['version', 'help', 'brokenControl', 'candidateControl'])) errors.push('events must contain exactly four probe events')
    const checked = Object.fromEntries(['version', 'help', 'brokenControl', 'candidateControl'].map(name => [
        name, validateSelftestEvent(events?.[name], name, errors, native, guard),
    ]))
    for (const name of ['version', 'help', 'brokenControl', 'candidateControl']) {
        resolveEventCwd(root, checked[name]?.cwd, name, errors)
    }
    if (checked.version && versionCommand && !isDeepStrictEqual(checked.version.command, versionCommand)) errors.push('version event command does not match versionCommand')
    if (checked.help && helpCommand && !isDeepStrictEqual(checked.help.command, helpCommand)) errors.push('help event command does not match helpCommand')
    if (checked.version && (checked.version.result !== 'completed' || checked.version.exitCode !== 0)) errors.push('version event must complete successfully')
    if (checked.help && (checked.help.result !== 'completed' || checked.help.exitCode !== 0)) errors.push('help event must complete successfully')
    if (checked.version && isText(record.version) && !`${checked.version.stdout}\n${checked.version.stderr}`.split(/\s+/).includes(record.version)) {
        errors.push('version event output does not contain the declared version')
    }
    if (!native && invocation) for (const [name, path] of [['candidateControl', record.candidatePath], ['brokenControl', record.brokenPath]]) {
        const expected = invocation.map(argument => argument === '{control}' ? path : argument)
        if (checked[name] && !isDeepStrictEqual(checked[name].command, expected)) errors.push(`${name} command does not match invocation`)
        if (checked[name] && !`${checked[name].command}\n${checked[name].stdout}\n${checked[name].stderr}`.includes(basename(path ?? ''))) {
            errors.push(`${name} does not name its control file`)
        }
        const cwd = checked[name] ? resolve(root, checked[name].cwd) : null
        const addressed = cwd && isText(path) ? resolve(cwd, path) : null
        const evidencePath = name === 'candidateControl' ? candidatePath : brokenPath
        if (addressed && evidencePath && (!existsSync(addressed) || realpathSync(addressed) !== realpathSync(evidencePath))) {
            errors.push(`${name} command does not resolve to its evidence path from cwd`)
        }
    }

    if (expectedHarness?.kind === 'builtin') {
        const authority = record.authority
        if (!exactKeys(authority, ['kind', 'name', 'executable']) || authority.kind !== 'native-executable'
            || authority.name !== expectedHarness.name) errors.push('built-in authority does not match expected harness identity')
        const toolCommands = [versionCommand, helpCommand, invocation, ...Object.values(checked).map(event => event?.command)]
            .filter(Boolean).map(command => canonicalToolCommand(command, 'selftest command', errors)).filter(Boolean)
        if (new Set(toolCommands.map(command => JSON.stringify(command))).size > 1) errors.push('every selftest command must use the same harness executable')
        validateHarnessExecutable(expectedHarness.name, invocation, errors, options, false)
        const canonical = canonicalExecutable(invocation, 'invocation', [])
        if (canonical && (!isText(authority?.executable) || !isAbsolute(authority.executable)
            || !existsSync(authority.executable) || realpathSync(authority.executable) !== canonical)) {
            errors.push('built-in authority executable does not match invocation')
        }
    } else if (expectedHarness?.kind === 'custom') {
        const authority = record.authority
        if (!exactKeys(authority, ['kind', 'harnessId', 'module', 'sourceSha256', 'export', 'stepId', 'startedAt', 'finishedAt'])
            || authority.kind !== 'custom-module' || authority.harnessId !== expectedHarness.id
            || authority.module !== expectedHarness.module || authority.sourceSha256 !== expectedHarness.sourceSha256
            || authority.export !== expectedHarness.export || !boundedText(authority.stepId, 128)
            || authority.startedAt !== record.startedAt || authority.finishedAt !== record.finishedAt) {
            errors.push('custom authority does not match expected harness identity')
        }
    }

    if (transcriptBytes) {
        let transcript
        try { transcript = JSON.parse(transcriptBytes.toString('utf8')) } catch (error) { errors.push(`transcript must be structured JSON evidence: ${errorCause(error)}`) }
        const expected = { ...record }
        delete expected.transcriptSha256
        if (transcript && !isDeepStrictEqual(transcript, expected)) errors.push('transcript does not match the complete structured evidence record')
    }

    if (guard) {
        const probe = record.guardProbe
        if (!exactKeys(probe, ['host', 'brokenCommand', 'receipts']) || probe.host !== expectation?.guardProbeHost
            || !exactKeys(probe.receipts, ['candidate', 'broken'])) errors.push('native guard probe must match its generated host authority')
        if (expectedHarness?.kind !== 'builtin' || expectedHarness.target !== 'claudecode' || record.capability !== 'guard-firing'
            || record.verdict !== 'enforced' || record.sample !== null || record.candidateCode !== 'NATIVE_GUARD_FIRED'
            || record.brokenCode !== 'NATIVE_GUARD_BROKEN') errors.push('native guard evidence establishes only Claude hook enforcement')
        if (!expectation?.nativeSourceSha256?.['.claude/settings.json']
            || record.candidateSha256 !== expectation.nativeSourceSha256['.claude/settings.json']) errors.push('native guard candidate does not match its generated settings source authority')
        const expectedInvocation = nativeGuardInvocation(probe?.host).map(value => value === '{executable}' ? invocation?.[0] : value)
        if (!isDeepStrictEqual(invocation, expectedInvocation) || !isDeepStrictEqual(versionCommand, [invocation?.[0], '--version'])
            || !isDeepStrictEqual(helpCommand, [invocation?.[0], '--help'])) errors.push('native guard commands do not match the closed protocol')
        if (record.version !== /^(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?) \(Claude Code\)$/.exec(typeof checked.version?.stdout === 'string' ? checked.version.stdout.trim() : '')?.[1]) errors.push('native version does not match the harness version output')
        const directory = transcriptPath ? dirname(transcriptPath) : undefined
        if (!exactKeys(record.modelInputs, ['candidate', 'broken']) || Object.values(record.modelInputs).some(value =>
            typeof value !== 'string' || Buffer.byteLength(value) > NATIVE_SELFTEST_STREAM_BYTES)
            || !exactKeys(record.modelEndpoints, ['candidate', 'broken'])) errors.push('native guard inputs must be bounded captured request arrays')
        for (const [role, path] of [['candidate', candidatePath], ['broken', brokenPath]]) {
            const event = checked[`${role}Control`]
            const endpoint = typeof record.modelEndpoints?.[role] === 'string'
                ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/([a-f0-9]{48})$/.exec(record.modelEndpoints[role]) : null
            const command = invocation?.map(value => value.replace('{control}', record[`${role}Path`] ?? '')
                .replaceAll('{loopback-port}', endpoint?.[1] ?? '').replaceAll('{nonce}', endpoint?.[2] ?? ''))
            if (!directory || !path || path !== resolve(directory, `${role}.json`) || realpathSync(path) !== path
                || !endpoint || Number(endpoint[1]) > 65535 || !event || event.cwd !== '.' || event.exitCode !== 0 || event.signal !== null
                || event.result !== (role === 'candidate' ? 'refused' : 'allowed') || event.code !== record[`${role}Code`]
                || !isDeepStrictEqual(event.command, command)) errors.push(`${role} must complete the bounded native guard protocol from the generated root`)
        }
        if (candidateBytes && brokenBytes && checked.candidateControl && checked.brokenControl) {
            const problem = validateNativeGuardPair({ host: probe?.host, guardCommand: expectation?.guardHookCommand, brokenCommand: probe?.brokenCommand,
                candidateBytes: candidateBytes.toString('utf8'), brokenBytes: brokenBytes.toString('utf8'),
                observations: Object.fromEntries(['candidate', 'broken'].map(role => [role, {
                    endpoint: record.modelEndpoints?.[role], input: record.modelInputs?.[role], receipts: probe?.receipts?.[role],
                }])), candidateStdout: checked.candidateControl.stdout, brokenStdout: checked.brokenControl.stdout })
            if (problem) errors.push(problem)
        }
        return
    }
    if (modelInput) {
        const target = record.protocol === 'claude-model-input/v1' ? 'claudecode' : 'codexcli'
        const skill = record.capability === 'skill-parity' ? record.sample?.skill : undefined
        const sourcePath = skill ? `.${target === 'claudecode' ? 'claude' : 'agents'}/skills/${skill}/SKILL.md` : 'AGENTS.md'
        if (expectedHarness?.kind !== 'builtin' || expectedHarness.target !== target || record.verdict !== 'instructed'
            || !['instruction-loading', 'skill-parity'].includes(record.capability) || target === 'codexcli' && !skill
            || (skill ? !isDeepStrictEqual(record.sample, { skill, features: ['body-load'] }) : record.sample !== null)) errors.push('native model input establishes only its instruction or skill body loading capability')
        const sourceDigest = expectation?.nativeSourceSha256?.[sourcePath]
        if (!sourceDigest || sourceDigest !== record.candidateSha256) errors.push(skill
            ? 'native candidate does not match the generated skill source authority'
            : 'native candidate does not match the generated instruction source authority')
        const expectedInvocation = nativeInputInvocation(target, skill).map(value => value === '{executable}' ? invocation?.[0] : value)
        if (!isDeepStrictEqual(invocation, expectedInvocation) || !isDeepStrictEqual(versionCommand, [invocation?.[0], '--version'])
            || !isDeepStrictEqual(helpCommand, [invocation?.[0], '--help'])) errors.push('native model input commands do not match the closed protocol')
        const versionPattern = target === 'claudecode' ? /^(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?) \(Claude Code\)$/
            : /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/
        if (record.version !== versionPattern.exec(typeof checked.version?.stdout === 'string' ? checked.version.stdout.trim() : '')?.[1]) errors.push('native version does not match the harness version output')
        const directory = transcriptPath ? dirname(transcriptPath) : undefined
        const expectedCode = skill ? 'NATIVE_SKILL_BODY_LOADED' : 'NATIVE_INSTRUCTIONS_LOADED'
        const brokenCode = skill ? 'NATIVE_SKILL_CONTROL_REJECTED' : 'NATIVE_INSTRUCTIONS_REPLACED'
        if (!exactKeys(record.modelEndpoints, ['candidate', 'broken']) || Object.values(record.modelEndpoints).some(value =>
            typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{48}$/.test(value)
            || Number(/^http:\/\/127\.0\.0\.1:([0-9]+)/.exec(value)?.[1]) > 65535)) errors.push('native model endpoints must be nonce-bound loopback listeners')
        if (record.candidateCode !== expectedCode || record.brokenCode !== brokenCode) errors.push('native model input diagnostic classifications do not match the capability')
        for (const [role, path, code] of [['candidate', candidatePath, expectedCode], ['broken', brokenPath, brokenCode]]) {
            const event = checked[`${role}Control`]
            const cwd = directory ? resolve(directory, role) : undefined
            const command = cwd && invocation?.map(value => value.replace('{model-endpoint}', record.modelEndpoints?.[role] ?? '')
                .replace('{native-settings}', resolve(cwd, 'native-settings.json')))
            if (!directory || !path || path !== resolve(cwd, sourcePath) || realpathSync(path) !== path
                || !event || event.exitCode !== 0 || event.signal !== null || event.result !== 'accepted' || event.code !== code
                || typeof event.cwd !== 'string' || resolve(root, event.cwd) !== cwd || !isDeepStrictEqual(event.command, command)) {
                errors.push(`${role} must complete native discovery from its confined control directory`)
            }
            if (target === 'claudecode' && cwd) {
                const settingsPath = resolve(cwd, 'native-settings.json')
                const settings = readBoundedSelftestFile(settingsPath, SELFTEST_MAX_STREAM_BYTES, 'native loader settings', errors)
                if (!settings || realpathSync(settingsPath) !== settingsPath || settings.toString('utf8') !== nativeInputSettings(cwd)) errors.push('native loader settings do not match the bounded ancestor exclusions')
            }
            if (!skill && cwd) {
                const wrapper = resolve(cwd, 'CLAUDE.md')
                const bytes = readBoundedSelftestFile(wrapper, SELFTEST_MAX_STREAM_BYTES, 'Claude instruction import', errors)
                if (!bytes || realpathSync(wrapper) !== wrapper || !nativeClaudeImport(bytes.toString('utf8'))
                    || textSha256(bytes) !== expectation?.nativeSourceSha256?.['CLAUDE.md']) errors.push('native Claude import does not match its generated source authority')
            }
        }
        if (!exactKeys(record.modelInputs, ['candidate', 'broken']) || Object.values(record.modelInputs).some(value =>
            typeof value !== 'string' || Buffer.byteLength(value) > NATIVE_SELFTEST_STREAM_BYTES)) errors.push('native model inputs must be bounded captured request arrays')
        else if (candidateBytes && brokenBytes && checked.candidateControl && checked.brokenControl) {
            const problem = validateNativeModelInputPair({ target, skill, candidateInput: record.modelInputs.candidate, brokenInput: record.modelInputs.broken,
                candidatePath, brokenPath, candidateBytes: candidateBytes.toString('utf8'), brokenBytes: brokenBytes.toString('utf8'),
                brokenStdout: checked.brokenControl.stdout, brokenStderr: checked.brokenControl.stderr })
            if (problem) errors.push(problem)
        }
        return
    }
    if (native) {
        if (expectedHarness?.kind !== 'builtin' || expectedHarness.target !== 'codexcli'
            || record.capability !== 'instruction-loading' || record.verdict !== 'instructed' || record.sample !== null
            || record.candidateCode !== 'NATIVE_INSTRUCTIONS_LOADED' || record.brokenCode !== 'NATIVE_INSTRUCTIONS_REPLACED') {
            errors.push('native prompt-input evidence only establishes Codex instruction loading')
        }
        if (record.version !== /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(typeof checked.version?.stdout === 'string' ? checked.version.stdout.trim() : '')?.[1]) errors.push('native version must match the Codex version output')
        if (!expectation?.instructionSourceSha256 || record.candidateSha256 !== expectation.instructionSourceSha256) {
            errors.push('native candidate does not match the generated AGENTS.md source authority')
        }
        if (!isDeepStrictEqual(invocation?.slice(1), ['debug', 'prompt-input', 'Do not run tools.'])
            || !isDeepStrictEqual(versionCommand, [invocation?.[0], '--version'])
            || !isDeepStrictEqual(helpCommand, [invocation?.[0], '--help'])) errors.push('native prompt-input commands do not match the closed protocol')
        for (const [name, path, code] of [
            ['candidateControl', candidatePath, 'NATIVE_INSTRUCTIONS_LOADED'],
            ['brokenControl', brokenPath, 'NATIVE_INSTRUCTIONS_REPLACED'],
        ]) {
            const event = checked[name]
            if (!event || event.exitCode !== 0 || event.signal !== null || event.result !== 'accepted' || event.code !== code
                || !isDeepStrictEqual(event.command, invocation) || !path || typeof event.cwd !== 'string' || resolve(root, event.cwd) !== dirname(path)) {
                errors.push(`${name} must complete native discovery from its control directory`)
            }
        }
        if ([candidatePath, brokenPath, transcriptPath].some(path => path && realpathSync(path) !== path)) errors.push('native evidence paths must be canonical without symlinks')
        if (!candidatePath || !brokenPath || basename(candidatePath) !== 'AGENTS.md' || basename(brokenPath) !== 'AGENTS.md'
            || basename(dirname(candidatePath)) !== 'candidate' || basename(dirname(brokenPath)) !== 'broken'
            || dirname(dirname(candidatePath)) !== dirname(dirname(brokenPath))
            || dirname(transcriptPath ?? '') !== dirname(dirname(candidatePath))) errors.push('native controls must use separate candidate and broken AGENTS.md directories beside the transcript')
        if (candidateBytes && brokenBytes && checked.candidateControl && checked.brokenControl) {
            const problem = validateNativeInstructionPair(checked.candidateControl.stdout, checked.brokenControl.stdout,
                dirname(candidatePath), dirname(brokenPath), candidateBytes.toString('utf8'), brokenBytes.toString('utf8'))
            if (problem) errors.push(problem)
        }
        return
    }

    const outputHasCode = (event, code) => event && `${event.stdout}\n${event.stderr}`.split(/\r?\n/).some(line => line.trim() === code)
    if (checked.brokenControl?.result !== 'rejected' || checked.brokenControl?.exitCode === 0
        || record.brokenCode !== checked.brokenControl?.code || !outputHasCode(checked.brokenControl, record.brokenCode)) {
        errors.push('every verdict requires a non-zero rejected broken control with its exact code')
    }
    if (record.capability !== 'skill-parity' && record.sample !== null) errors.push('sample must be null outside skill-parity')
    if (record.capability === 'skill-parity') {
        if (!exactKeys(record.sample, ['skill', 'features']) || !isText(record.sample.skill)
            || !Array.isArray(record.sample.features) || record.sample.features.length === 0
            || new Set(record.sample.features).size !== record.sample.features.length
            || record.sample.features.some(feature => !SELFTEST_SAMPLE_FEATURES.includes(feature))) {
            errors.push('skill-parity requires one bounded skill sample with unique known features')
        }
    }
    if (record.verdict === 'enforced') {
        if (record.capability !== 'guard-firing') errors.push('only guard-firing can have an enforced verdict')
        if (checked.candidateControl?.result !== 'refused' || checked.candidateControl?.exitCode === 0
            || record.candidateCode !== checked.candidateControl?.code || !outputHasCode(checked.candidateControl, record.candidateCode)) {
            errors.push('enforced verdict requires a non-zero refused candidate control with its exact code')
        }
    } else if (record.verdict === 'instructed') {
        if (checked.candidateControl?.result !== 'accepted' || checked.candidateControl?.exitCode !== 0
            || record.candidateCode !== checked.candidateControl?.code || !outputHasCode(checked.candidateControl, record.candidateCode)) {
            errors.push('instructed verdict requires an accepted candidate canary with its exact code')
        }
    } else if (record.verdict === 'unavailable') {
        const unavailableCode = `${String(record.capability).replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`
        if (!checked.candidateControl || !['unavailable', 'allowed'].includes(checked.candidateControl.result)
            || checked.candidateControl.result === 'unavailable' && checked.candidateControl.exitCode === 0
            || checked.candidateControl.result === 'allowed' && checked.candidateControl.exitCode !== 0
            || record.candidateCode !== unavailableCode || checked.candidateControl.code !== unavailableCode
            || !outputHasCode(checked.candidateControl, unavailableCode)) {
            errors.push('unavailable verdict requires a driven unavailable or allowed event with its capability code')
        }
    }
}

function validateSelftestReview(row, expectedReview, skills, evidence, errors) {
    const fields = ['skill', 'harness', 'status', 'reviewedOn', 'evidenceRunId', 'reviewers', 'checks', 'operatorAction']
    if (!exactKeys(row, fields)) {
        errors.push('skill review contains unknown or missing fields')
        return
    }
    if (!skills.includes(row.skill)) errors.push('skill review names an undeclared shipped skill')
    if (!expectedReview || row.harness !== expectedReview.name) errors.push('skill review names an unexpected review harness')
    if (row.status === 'evidenced') {
        if (!canonicalDate(row.reviewedOn) || !boundedText(row.evidenceRunId, 128)) {
            errors.push('evidenced skill review requires a date and evidence run ID')
        }
        const reviewers = expectedReview?.nativeDiagnostics
            ? ['official-authoring', 'harness-diagnostics'] : ['official-authoring']
        if (!isDeepStrictEqual(row.reviewers, reviewers)) errors.push('evidenced skill review has the wrong reviewer authorities')
        if (!exactKeys(row.checks, ['trigger', 'silence', 'bodyLoad', 'tools', 'nonGoals'])
            || Object.values(row.checks ?? {}).some(result => result !== 'pass')) errors.push('evidenced skill review requires all five passing checks')
        if (row.operatorAction !== null) errors.push('evidenced skill review must not carry operatorAction')
        const evidenceRow = evidence.find(record => record.runId === row.evidenceRunId)
        if (!evidenceRow || evidenceRow.capability !== 'skill-parity' || evidenceRow.sample?.skill !== row.skill
            || evidenceRow.harness?.name !== row.harness) errors.push('evidenced skill review must bind its harness skill-parity run')
        else if (evidenceRow.verdict !== 'instructed'
            || SELFTEST_SAMPLE_FEATURES.some(feature => !evidenceRow.sample.features.includes(feature))) {
            errors.push('evidenced skill review requires instructed evidence covering every skill feature')
        }
    } else if (row.status === 'human_needed') {
        if (row.reviewedOn !== null || row.evidenceRunId !== null || !Array.isArray(row.reviewers) || row.reviewers.length !== 0
            || row.checks !== null || !boundedText(row.operatorAction)) errors.push('human-needed skill review must contain only an actionable operator remainder')
    } else errors.push(`unknown skill review status: ${String(row.status)}`)
}

export function validateSelftestEvidenceBundle(bundle, expectation, root = process.cwd(), options = undefined) {
    const errors = []
    const capturedExpectation = captureSelftestData(expectation, 'expectation', errors)
    const capturedBundle = captureSelftestData(bundle, 'bundle', errors)
    if (!capturedExpectation || !capturedBundle) return { errors, evidence: [], pending: [], skillReviews: [] }
    expectation = capturedExpectation
    bundle = capturedBundle
    const expected = validateSelftestExpectation(expectation, errors)
    if (errors.length > 0) return { errors, evidence: [], pending: [], skillReviews: [] }
    if (!exactKeys(bundle, ['schema', 'generatedManifestSha256', 'records', 'skillInventory', 'skillReviews'])) {
        errors.push('bundle must contain only the versioned selftest fields')
        return { errors, evidence: [], pending: [], skillReviews: [] }
    }
    if (bundle.schema !== 'cockpit-harness-selftest/v1') errors.push('unknown selftest bundle schema')
    if (bundle.generatedManifestSha256 !== expectation?.generatedManifestSha256) {
        errors.push('bundle generatedManifestSha256 does not match expectation')
    }
    const records = Array.isArray(bundle.records) ? bundle.records : []
    if (records.length === 0 || records.length > SELFTEST_MAX_ROWS) errors.push('bundle records must contain between 1 and 256 rows')
    const evidence = []
    const pending = []
    const recordKeys = []
    records.forEach((record, index) => {
        const rowErrors = []
        if (!isRecord(record)) {
            errors.push(`record ${index + 1}: must be an object`)
            return
        }
        const key = selftestCell(record, `record ${index + 1}`, rowErrors, false)
        if (key) recordKeys.push(key)
        const expectedCell = key ? expected.cells[expected.cellKeys.indexOf(key)] : undefined
        if (!expectedCell) rowErrors.push('cell is not present in expectation authority')
        else if (!isDeepStrictEqual(record.harness, expectedCell.harness)) rowErrors.push('harness identity does not equal expected cell')
        else if (record.capability === 'skill-parity'
            && (record.kind === 'evidence' ? record.sample?.skill : record.skill) !== expectedCell.skill) {
            rowErrors.push('skill identity does not equal expected cell')
        }
        if (record.generatedManifestSha256 !== expectation?.generatedManifestSha256) rowErrors.push('generated manifest digest does not match expectation')
        if (record.kind === 'human_needed') {
            const fields = record.capability === 'skill-parity'
                ? ['kind', 'harness', 'capability', 'skill', 'generatedManifestSha256', 'observedAt', 'reason', 'operatorAction']
                : ['kind', 'harness', 'capability', 'generatedManifestSha256', 'observedAt', 'reason', 'operatorAction']
            if (!exactKeys(record, fields)) {
                rowErrors.push('human-needed record contains unknown or missing fields')
            }
            if (canonicalInstant(record.observedAt) === null) rowErrors.push('observedAt must be a canonical ISO instant')
            if (!SELFTEST_HUMAN_REASONS.includes(record.reason)) rowErrors.push(`unknown human-needed reason: ${String(record.reason)}`)
            if (!boundedText(record.operatorAction)) rowErrors.push('operatorAction must be bounded actionable text')
            if (rowErrors.length === 0) pending.push(record)
        } else if (record.kind === 'evidence') {
            validateSelftestEvidence(record, expectedCell?.harness, root, options, rowErrors, expectation)
            if (record.capability === 'skill-parity' && !expected.skills.includes(record.sample?.skill)) {
                rowErrors.push('skill-parity sample must name a shipped skill')
            }
            if (rowErrors.length === 0) evidence.push(record)
        } else rowErrors.push(`unknown selftest record kind: ${String(record.kind)}`)
        for (const error of rowErrors) errors.push(`record ${index + 1}: ${error}`)
    })
    if (new Set(recordKeys).size !== recordKeys.length) errors.push('bundle records contain duplicate cells')
    if (recordKeys.length !== expected.cellKeys.length || new Set(recordKeys).size !== expected.cellKeys.length
        || expected.cellKeys.some(key => !recordKeys.includes(key))) errors.push('bundle records do not exactly cover expected cells')

    const addressableEvidence = records.filter(record => record?.kind === 'evidence'
        && isText(record.runId) && isText(record.candidatePath) && isText(record.brokenPath) && isText(record.transcriptPath))
    const runIds = addressableEvidence.map(record => record.runId)
    if (new Set(runIds).size !== runIds.length) errors.push('evidence run IDs must be unique')
    const triples = addressableEvidence.map(record => `${record.candidatePath}\0${record.brokenPath}\0${record.transcriptPath}`)
    if (new Set(triples).size !== triples.length) errors.push('evidence triples must be unique')
    const canonicalTriples = addressableEvidence.map(record => [record.candidatePath, record.brokenPath, record.transcriptPath].map(path => {
        // An unresolvable path is compared as written; the missing file is refused where its evidence is read.
        try { return realpathSync(resolve(root, path)) } catch { return String(path) }
    }).join('\0'))
    if (new Set(canonicalTriples).size !== canonicalTriples.length) errors.push('canonical evidence triples must be unique')

    if (!Array.isArray(bundle.skillInventory) || !isDeepStrictEqual(bundle.skillInventory, expected.skills)) {
        errors.push('skillInventory must exactly equal expectation shippedSkills')
    }
    const reviews = Array.isArray(bundle.skillReviews) ? bundle.skillReviews : []
    if (reviews.length > SELFTEST_MAX_ROWS * 2) errors.push('skillReviews exceeds the bounded review matrix')
    const reviewKeys = []
    const acceptedReviews = []
    reviews.forEach((review, index) => {
        const reviewErrors = []
        const reviewExpectation = expected.reviews.find(item => item?.name === review?.harness)
        validateSelftestReview(review, reviewExpectation, expected.skills, evidence, reviewErrors)
        if (isRecord(review) && isText(review.skill) && isText(review.harness)) reviewKeys.push(`${review.skill}/${review.harness}`)
        if (reviewErrors.length === 0) acceptedReviews.push(review)
        for (const error of reviewErrors) errors.push(`skill review ${index + 1}: ${error}`)
    })
    const expectedReviewKeys = expected.skills.flatMap(skill => expected.reviews.map(review => `${skill}/${review.name}`))
    if (reviewKeys.length !== expectedReviewKeys.length || new Set(reviewKeys).size !== expectedReviewKeys.length
        || expectedReviewKeys.some(key => !reviewKeys.includes(key))) {
        errors.push('skillReviews do not exactly cover the shipped skill and review harness matrix')
    }
    const reviewRunIds = reviews.filter(row => row?.status === 'evidenced').map(row => row.evidenceRunId)
    if (new Set(reviewRunIds).size !== reviewRunIds.length) errors.push('evidenced skill review run IDs must be unique')
    return { errors, evidence, pending, skillReviews: acceptedReviews }
}

function sortRows(rows) {
    return [...rows].sort((left, right) => {
        const harness = HARNESSES.indexOf(left.harness) - HARNESSES.indexOf(right.harness)
        return harness || CAPABILITIES.indexOf(left.capability) - CAPABILITIES.indexOf(right.capability)
    })
}

export function validateEvidenceManifests(manifests, root = process.cwd(), options = undefined) {
    const errors = []
    const captured = captureSelftestData(manifests, 'manifests', errors)
    if (!Array.isArray(captured)) return { errors, rows: [] }
    if (captured.length === 0) return { errors: ['no evidence manifests supplied'], rows: [] }
    const rowErrors = captured.map((manifest, index) => {
        const found = validateEvidenceManifest(manifest, root, options)
        for (const error of found) errors.push(`row ${index + 1}: ${error}`)
        return found
    })
    const addressableRows = captured.filter(
        (row) =>
            isRecord(row) &&
            ['harness', 'capability', 'runId', 'candidatePath', 'brokenPath', 'transcriptPath'].every((field) =>
                isText(row[field]),
            ),
    )
    const validRows = captured.filter((row, index) => isRecord(row) && rowErrors[index].length === 0)
    const keys = addressableRows.map((row) => `${row.harness}/${row.capability}`)
    const expected = HARNESSES.flatMap((harness) => CAPABILITIES.map((capability) => `${harness}/${capability}`))
    if (keys.length !== expected.length || new Set(keys).size !== expected.length || expected.some((key) => !keys.includes(key))) {
        errors.push('expected exactly six harness/capability rows')
    }
    if (
        addressableRows.length === expected.length &&
        new Set(addressableRows.map((row) => row.runId)).size !== addressableRows.length
    ) {
        errors.push('expected six distinct run IDs')
    }
    const evidenceTriples = addressableRows.map((row) => `${row.candidatePath}\0${row.brokenPath}\0${row.transcriptPath}`)
    if (addressableRows.length === expected.length && new Set(evidenceTriples).size !== addressableRows.length) {
        errors.push('expected six distinct evidence triples')
    }
    const canonicalEvidenceTriples = addressableRows.map((row) =>
        [row.candidatePath, row.brokenPath, row.transcriptPath]
            .map((path) => {
                try {
                    return realpathSync(resolve(root, path))
                } catch {
                    // An unresolvable path is compared as written; the missing file is refused where its evidence is read.
                    return String(path)
                }
            })
            .join('\0'),
    )
    if (
        addressableRows.length === expected.length &&
        new Set(canonicalEvidenceTriples).size !== addressableRows.length
    ) {
        errors.push('expected six distinct canonical evidence triples')
    }
    return { errors, rows: sortRows(validRows) }
}

class ManifestSyntaxError extends Error {}

// JSON.parse reports the text where it stopped, and a manifest can carry anything: say where
// parsing stopped and what was expected, never the bytes near it.
function parseManifestText(bytes) {
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
        throw new ManifestSyntaxError('manifest is not valid UTF-8; expected one JSON evidence row')
    }
    try { return JSON.parse(text) } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        const position = Number(/\bposition (\d+)\b/.exec(error.message)?.[1])
        const before = Number.isSafeInteger(position) ? text.slice(0, position) : undefined
        const where = before === undefined ? '' : ` at line ${before.split('\n').length}, column ${before.length - before.lastIndexOf('\n')}`
        throw new ManifestSyntaxError(`manifest is not valid JSON${where}; expected one JSON evidence row`)
    }
}

export function runHarnessEvidenceValidatorCli(paths) {
    if (paths.length === 0) {
        console.error('validate-harness-evidence: no evidence manifests supplied')
        return 1
    }
    const rows = []
    const readErrors = []
    for (const path of paths) {
        const errors = []
        try {
            const bytes = readBoundedSelftestFile(path, LEGACY_MANIFEST_MAX_BYTES, 'manifest', errors)
            if (!bytes) {
                readErrors.push(...errors.map(error => `${path}: ${error}`))
                continue
            }
            rows.push(parseManifestText(bytes))
        } catch (error) {
            readErrors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    const result = validateEvidenceManifests(rows)
    const errors = [...readErrors, ...result.errors]
    if (errors.length > 0) {
        for (const error of errors) console.error(`validate-harness-evidence: ${error}`)
        return 1
    }
    process.stdout.write(`${JSON.stringify(result.rows, null, 2)}\n`)
    return 0
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    process.exitCode = runHarnessEvidenceValidatorCli(process.argv.slice(2))
}
