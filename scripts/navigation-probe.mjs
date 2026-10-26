#!/usr/bin/env node

import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
    cpSync,
    closeSync,
    existsSync,
    lstatSync,
    mkdtempSync,
    mkdirSync,
    openSync,
    readSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const mechanism = {
    id: 'documentation-navigation-probe',
    module: 'scripts/navigation-probe.mjs',
    exports: ['prepareNavigationProbe', 'runNavigationProbe', 'renderNavigationEvidence'],
}

const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const PUBLIC_METADATA_DIRECTORIES = new Set(['.github', '.githooks', '.changeset'])
const FORBIDDEN_PATHS = [ 'internal', '.git', '.claude/work' + 'trees', '.codex/sessions', '.opencode/sessions']
const ALLOWED_ENVIRONMENT = new Set(['PATH', 'HOME', 'TMPDIR', 'TERM', 'USER', 'LANG', 'LC_ALL', 'NO_COLOR'])
const REQUIRED_KINDS = ['purpose', 'contract', 'implementation', 'test', 'command']
const SCOPE_EVIDENCE_KEYS = ['anchor', 'contractPath', 'id', 'ownerPath', 'testPath', 'verificationCommand', 'verificationPath']
const SECRET_PATTERN = /(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|(?:api|access|secret)[_-]?key\s*[:=]\s*\S+)/i
const CONTROL_DETECTOR_CODE = 'NAVIGATION_CONTROL_DETECTED'
const SYSTEM_READ_SUBPATHS = ['/System/Library', '/usr/lib', '/usr/share/zoneinfo', '/private/etc/ssl']
const CLAUDE_ICU_DATA_DIRECTORY = '/usr/share/icu'
const SYSTEM_READ_LITERALS = [
    '/',
    '/private/etc/hosts',
    '/private/etc/resolv.conf',
    '/private/etc/services',
    '/private/etc/protocols',
    '/dev/null',
    '/dev/random',
    '/dev/urandom',
]
const PROVIDER_MACH_SERVICES = [
    'com.apple.SystemConfiguration.configd',
    'com.apple.securityd',
    'com.apple.trustd',
    'com.apple.trustd.agent',
]
const CONTROL_VALIDATOR_SOURCE = `
const fs = require('node:fs')
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
if (input.controlMarkerDetected !== true) process.exit(0)
process.stderr.write('NAVIGATION_CONTROL_DETECTED\\n')
process.exit(1)
`.trim()

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function git(root, arguments_, options = {}) {
    return execFileSync('git', arguments_, {
        cwd: root,
        encoding: options.encoding === null ? null : (options.encoding ?? 'utf8'),
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
}

function commit(root, revision) {
    try {
        return git(root, ['rev-parse', '--verify', `${revision}^{commit}`]).trim()
    } catch {
        throw new Error(`unknown committed revision: ${revision}`)
    }
}

function within(root, path) {
    const child = relative(root, path)
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function pathForbidden(path) {
    const parts = path.split('/')
    const hiddenDirectory = parts.length > 1 && parts[0].startsWith('.') && !PUBLIC_METADATA_DIRECTORIES.has(parts[0])
    return hiddenDirectory || FORBIDDEN_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
        || /(^|\/)(?:worktree|session)(?:s|[-_][^/]*)?(\/|$)/i.test(path)
}

function assertPublicPaths(paths) {
    for (const path of paths) {
        if (pathForbidden(path) || path.startsWith('/') || path.split('/').includes('..')) {
            throw new Error(`forbidden public archive path: ${path}`)
        }
    }
}

function assertConfinedLinks(root, current = root) {
    for (const entry of readdirSync(current)) {
        const path = join(current, entry)
        const stat = lstatSync(path)
        if (stat.isSymbolicLink()) {
            let target
            try {
                target = realpathSync(path)
            } catch {
                throw new Error(`archive contains an unresolved symbolic link: ${relative(root, path)}`)
            }
            if (!within(root, target)) throw new Error(`archive symbolic link escapes its tree: ${relative(root, path)}`)
        } else if (stat.isDirectory()) {
            assertConfinedLinks(root, path)
        }
    }
}

function readManifest(path) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('review manifest must be an object')
    return parsed
}

function changedInventory(repository, base, head) {
    const tokens = git(repository, ['diff', '--name-status', '--no-renames', '-z', `${base}..${head}`]).split('\0').filter(Boolean)
    const files = []
    for (let index = 0; index < tokens.length; index += 2) {
        const status = tokens[index]
        const path = tokens[index + 1]
        if (!/^[ADMT]$/.test(status) || path === undefined) throw new Error('committed changed file inventory is invalid')
        files.push({
            path,
            state: status === 'D' ? 'deleted' : 'present',
            sha256: status === 'D' ? null : sha256(git(repository, ['show', `${head}:${path}`], { encoding: null })),
        })
    }
    return files.sort((left, right) => left.path.localeCompare(right.path))
}

function validateManifest(repository, manifest, base, head) {
    if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(['base', 'files', 'head', 'navigationScope', 'pathSetSha256'])) {
        throw new Error('review manifest does not use the canonical schema')
    }
    if (manifest.base !== base || manifest.head !== head) throw new Error('review manifest does not bind the requested base and head')
    const supplied = manifest.files
    if (!Array.isArray(supplied) || supplied.some((row) => !row
        || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(['path', 'sha256', 'state'])
        || typeof row.path !== 'string'
        || !['present', 'deleted'].includes(row.state)
        || (row.state === 'present' ? !/^[a-f0-9]{64}$/.test(row.sha256) : row.sha256 !== null))) {
        throw new Error('review manifest needs canonical path, state, and sha256 rows')
    }
    const names = supplied.map(({ path }) => path)
    if (JSON.stringify(names) !== JSON.stringify([...names].sort((left, right) => left.localeCompare(right)))) {
        throw new Error('review manifest needs a sorted changed file inventory')
    }
    if (new Set(names).size !== names.length) throw new Error('review manifest changed file inventory contains duplicates')
    assertPublicPaths(names)
    const expected = changedInventory(repository, base, head)
    if (JSON.stringify(supplied) !== JSON.stringify(expected)) throw new Error('review manifest differs from the committed changed file inventory')
    if (manifest.pathSetSha256 !== sha256(`${names.join('\n')}\n`)) throw new Error('review manifest path-set digest does not match')
    const navigationScope = manifest.navigationScope
    if (!Array.isArray(navigationScope)
        || navigationScope.some((item) => typeof item !== 'string' || item.trim() === '')
        || JSON.stringify(navigationScope) !== JSON.stringify([...new Set(navigationScope)].sort())) {
        throw new Error('review manifest needs a sorted unique navigation scope')
    }
}

function seatbeltPath(path) {
    return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function profile({ tree, writable, forbidden, brokenAllow = [], executablePaths = [], literalReadPaths = [] }) {
    const reads = [...new Set([...SYSTEM_READ_SUBPATHS, tree, writable])]
    return [
        '(version 1)',
        '(deny default)',
        '(allow process-fork)',
        '(allow process-info* (target self))',
        '(allow signal (target self))',
        '(allow sysctl-read)',
        ...PROVIDER_MACH_SERVICES.map((service) => `(allow mach-lookup (global-name "${service}"))`),
        // Provider endpoints and redirects are dynamic, so transport cannot use a static host list.
        '(allow network-outbound)',
        ...executablePaths.map((path) => `(allow process-exec (literal "${seatbeltPath(path)}"))`),
        ...reads.map((path) => `(allow file-read* (subpath "${seatbeltPath(path)}"))`),
        ...[...SYSTEM_READ_LITERALS, ...executablePaths, ...literalReadPaths].map((path) => `(allow file-read* (literal "${seatbeltPath(path)}"))`),
        '(allow file-write* (literal "/dev/null"))',
        `(allow file-write* (subpath "${seatbeltPath(writable)}"))`,
        ...forbidden.map((path) => `(deny file-read* (subpath "${seatbeltPath(path)}"))`),
        ...brokenAllow.map((path) => `(allow file-read* (subpath "${seatbeltPath(path)}"))`),
    ].join('\n') + '\n'
}

function createHarnessPreparation(root, harness, archive, forbiddenRoots, sentinel) {
    const parent = join(root, harness)
    const candidate = join(parent, 'candidate')
    const brokenControl = join(parent, 'broken-control')
    const writable = join(parent, 'runtime')
    mkdirSync(candidate, { recursive: true, mode: 0o700 })
    mkdirSync(writable, { recursive: true, mode: 0o700 })
    execFileSync('tar', ['-xf', archive, '-C', candidate], { stdio: 'ignore' })
    assertConfinedLinks(candidate)
    cpSync(candidate, brokenControl, { recursive: true, dereference: false, preserveTimestamps: true })
    const candidateProfile = join(parent, 'candidate.sb')
    const controlProfile = join(parent, 'broken-control.sb')
    const brokenProfile = join(parent, 'broken-confinement.sb')
    const executablePaths = ['/bin/cat']
    writeFileSync(candidateProfile, profile({ tree: candidate, writable, forbidden: [...forbiddenRoots, brokenControl], executablePaths }), { mode: 0o600 })
    writeFileSync(controlProfile, profile({ tree: brokenControl, writable, forbidden: [...forbiddenRoots, candidate], executablePaths }), { mode: 0o600 })
    writeFileSync(brokenProfile, profile({
        tree: candidate,
        writable,
        forbidden: [...forbiddenRoots.filter((path) => path !== sentinel), brokenControl],
        brokenAllow: [sentinel],
        executablePaths,
    }), { mode: 0o600 })
    return { parent, candidate, brokenControl, writable, profiles: { candidate: candidateProfile, brokenControl: controlProfile }, brokenProfile, forbiddenRoots }
}

export async function prepareNavigationProbe(input) {
    const repository = realpathSync(input.repository)
    const base = commit(repository, input.base)
    const head = commit(repository, input.head)
    if (base === head) throw new Error('base and head must be distinct commits')
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', base, head], { cwd: repository, stdio: 'ignore' })
    } catch {
        throw new Error('base must be an ancestor of head')
    }
    if (git(repository, ['status', '--porcelain', '--untracked-files=no']).trim() !== '') {
        throw new Error('repository has dirty tracked state')
    }
    const manifest = readManifest(input.reviewManifest)
    validateManifest(repository, manifest, base, head)
    const archivePaths = git(repository, ['ls-tree', '-r', '--name-only', head]).split('\n').filter(Boolean)
    assertPublicPaths(archivePaths)

    if (!isAbsolute(input.destination)) throw new Error('probe destination must be absolute')
    const destination = resolve(input.destination)
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    const destinationStat = lstatSync(destination)
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
        throw new Error('probe destination must be a real directory')
    }
    const root = realpathSync(destination)
    if (readdirSync(root).length !== 0) throw new Error('probe destination must be empty')
    const archive = join(root, 'public-tree.tar')
    execFileSync('git', ['archive', '--format=tar', '--output', archive, head], { cwd: repository, stdio: 'ignore' })
    const sentinel = join(root, 'confinement-sentinel')
    mkdirSync(sentinel, { mode: 0o700 })
    writeFileSync(join(sentinel, 'credential-store'), 'synthetic host marker\n', { mode: 0o600 })
    const codexParent = join(root, 'codex')
    const claudeParent = join(root, 'claude')
    const codex = createHarnessPreparation(root, 'codex', archive, [repository, claudeParent, sentinel], sentinel)
    const claude = createHarnessPreparation(root, 'claude', archive, [repository, codexParent, sentinel], sentinel)
    const controlMarker = `navigation-control-${sha256(`${head}:${manifest.pathSetSha256}`).slice(0, 24)}`
    writeFileSync(join(codex.brokenControl, '.navigation-control'), controlMarker, { mode: 0o600 })
    writeFileSync(join(claude.brokenControl, '.navigation-control'), controlMarker, { mode: 0o600 })
    rmSync(archive)
    return { root, base, commit: head, controlMarker, manifest, sentinel, harnesses: { codex, claude } }
}

function shellWord(value) {
    return /^[A-Za-z0-9_./,:=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

function displayCommand(harness, prompt) {
    const args = harness === 'codex'
        ? ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C', '<tree>', '--json', '-o', '<last-message>', prompt]
        : ['-p', '--restricted', '--setting-sources', 'project', '--permission-mode', 'plan', '--permission-prompts', 'none', '--allowedTools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '<empty-config>', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', prompt]
    return [harness, ...args].map(shellWord).join(' ')
}

function boundedEnvironment(harness, writable, override = {}) {
    const specific = harness === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
    for (const name of Object.keys(override)) {
        if (!ALLOWED_ENVIRONMENT.has(name)) throw new Error(`environment name is not allow-listed: ${name}`)
    }
    const environment = {}
    for (const name of ALLOWED_ENVIRONMENT) if (process.env[name] !== undefined) environment[name] = process.env[name]
    Object.assign(environment, override)
    environment.HOME = join(writable, 'home')
    environment.TMPDIR = join(writable, 'tmp')
    environment[specific] = join(writable, harness === 'codex' ? 'codex-home' : 'claude-config')
    for (const path of [environment.HOME, environment.TMPDIR, environment[specific]]) mkdirSync(path, { recursive: true, mode: 0o700 })
    return environment
}

function processGroupAlive(pid) {
    try {
        process.kill(-pid, 0)
        return true
    } catch (error) {
        if (error && error.code === 'ESRCH') return false
        if (error && error.code === 'EPERM') return true
        throw error
    }
}

function killGroup(pid, signal) {
    try {
        process.kill(-pid, signal)
    } catch (error) {
        if (!error || (error.code !== 'ESRCH' && error.code !== 'EPERM')) throw error
    }
}

async function execute({ executable, arguments_, cwd, environment, timeoutMs, maxOutputBytes }) {
    return await new Promise((resolveExecution, rejectExecution) => {
        const child = spawn(executable, arguments_, { cwd, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let pid
        const chunks = []
        let bytes = 0
        let finishing = false
        let timeout
        const finish = (status, signalName, failure = null) => {
            if (finishing) return
            finishing = true
            if (timeout !== undefined) clearTimeout(timeout)
            if (pid === undefined) {
                rejectExecution(failure ?? new Error('navigation process did not receive a process id'))
                return
            }
            try {
                if (failure !== null) killGroup(pid, 'SIGTERM')
            } catch (error) {
                rejectExecution(error)
                return
            }
            setTimeout(() => {
                try {
                    if (processGroupAlive(pid)) killGroup(pid, 'SIGKILL')
                } catch (error) {
                    rejectExecution(error)
                    return
                }
                setTimeout(() => {
                    try {
                        if (processGroupAlive(pid)) {
                            rejectExecution(new Error('navigation process group cleanup is incomplete'))
                            return
                        }
                        if (failure !== null) rejectExecution(failure)
                        else resolveExecution({ status: status ?? 128, signal: signalName, output: Buffer.concat(chunks).toString('utf8') })
                    } catch (error) {
                        rejectExecution(error)
                    }
                }, 25)
            }, 25)
        }
        child.on('error', (error) => finish(null, null, error))
        pid = child.pid
        if (pid === undefined) {
            setImmediate(() => finish(null, null, new Error('navigation process did not receive a process id')))
            return
        }
        const collect = (chunk) => {
            bytes += chunk.length
            if (bytes > maxOutputBytes) {
                child.stdout.destroy()
                child.stderr.destroy()
                finish(null, null, new Error(`navigation output exceeded ${maxOutputBytes} bytes`))
                return
            }
            chunks.push(chunk)
        }
        child.stdout.on('data', collect)
        child.stderr.on('data', collect)
        timeout = setTimeout(() => {
            child.stdout.destroy()
            child.stderr.destroy()
            finish(null, null, new Error(`navigation process exceeded ${timeoutMs}ms`))
        }, timeoutMs)
        child.on('close', finish)
    })
}

function jsonLines(raw) {
    return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

function parsePayload(harness, raw) {
    if (harness === 'codex') return JSON.parse(raw)
    const result = jsonLines(raw).findLast((event) => event?.type === 'result')
    if (!result || typeof result.result !== 'string') throw new Error('claude omitted its final navigation result')
    return JSON.parse(result.result)
}

function nativeOpenedPaths(harness, transcript, tree) {
    const canonicalTree = realpathSync(tree)
    const normalizePath = (path) => {
        if (!isAbsolute(path)) return path.replace(/^\.\//, '')
        let canonicalPath
        try {
            canonicalPath = realpathSync(path)
        } catch {
            return path
        }
        return within(canonicalTree, canonicalPath)
            ? relative(canonicalTree, canonicalPath).split(sep).join('/')
            : path
    }
    if (harness === 'codex') {
        const paths = []
        for (const event of jsonLines(transcript)) {
            const item = event?.type === 'item.completed' ? event.item : null
            if (item?.type !== 'command_execution' || item.exit_code !== 0 || typeof item.aggregated_output !== 'string' || item.aggregated_output === '') continue
            const match = /^cat -- ([A-Za-z0-9._/-]+)$/.exec(item.command ?? '')
            if (match) paths.push(normalizePath(match[1]))
        }
        return [...new Set(paths)].sort()
    }
    const reads = new Map()
    const completed = new Set()
    for (const event of jsonLines(transcript)) {
        for (const content of event?.message?.content ?? []) {
            if (event.type === 'assistant' && content?.type === 'tool_use' && content.name === 'Read'
                && typeof content.id === 'string' && typeof content.input?.file_path === 'string') {
                reads.set(content.id, normalizePath(content.input.file_path))
            }
            if (event.type === 'user' && content?.type === 'tool_result' && content.is_error !== true
                && typeof content.tool_use_id === 'string' && content.content !== '') {
                completed.add(content.tool_use_id)
            }
        }
    }
    return [...new Set([...reads].filter(([id]) => completed.has(id)).map(([, path]) => path))].sort()
}

function validateTreeFile(tree, path) {
    if (typeof path !== 'string' || path === '' || pathForbidden(path) || isAbsolute(path) || path.split('/').includes('..')) {
        throw new Error('candidate reported an out-of-tree navigation path')
    }
    let resolvedPath
    try {
        resolvedPath = realpathSync(resolve(tree, path))
    } catch {
        throw new Error('candidate reported a missing navigation file')
    }
    if (!within(tree, resolvedPath) || !lstatSync(resolvedPath).isFile()) {
        throw new Error('candidate reported an invalid navigation file')
    }
    return resolvedPath
}

function validatedCandidate(payload, tree, scope, transcriptPaths) {
    const canonicalTree = realpathSync(tree)
    if (!payload || !Array.isArray(payload.located) || payload.located.length !== REQUIRED_KINDS.length) {
        throw new Error('candidate did not return the ordered navigation schema')
    }
    if (payload.located.some((row, index) => row?.kind !== REQUIRED_KINDS[index] || typeof row.path !== 'string')) {
        throw new Error('candidate navigation kinds or paths are invalid')
    }
    if (typeof payload.exactCommand !== 'string' || payload.exactCommand.trim() === '') throw new Error('candidate omitted the exact verification command')
    if (!Array.isArray(payload.openedPaths) || payload.openedPaths.some((path) => typeof path !== 'string')) throw new Error('candidate opened-path evidence is invalid')
    const reportedOpenedPaths = [...new Set(payload.openedPaths)].sort()
    if (JSON.stringify(reportedOpenedPaths) !== JSON.stringify(transcriptPaths)) {
        throw new Error('candidate opened paths lack matching native transcript evidence')
    }
    for (const path of [...payload.located.map((row) => row.path), ...reportedOpenedPaths]) validateTreeFile(canonicalTree, path)
    const commandPath = payload.located.find((row) => row.kind === 'command').path
    if (!readFileSync(resolve(canonicalTree, commandPath), 'utf8').includes(payload.exactCommand)) {
        throw new Error('candidate command was not found in its reported file')
    }
    if (!Array.isArray(payload.scopeEvidence) || payload.scopeEvidence.length !== scope.length) {
        throw new Error('candidate omitted item-by-item navigation scope evidence')
    }
    const scopeEvidence = payload.scopeEvidence.map((row, index) => {
        if (!row || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(SCOPE_EVIDENCE_KEYS)
            || row.id !== scope[index]
            || [row.ownerPath, row.contractPath, row.testPath, row.verificationPath, row.verificationCommand, row.anchor]
                .some((value) => typeof value !== 'string' || value.trim() === '')
            || row.anchor.trim().length < 8) {
            throw new Error('candidate navigation scope evidence is invalid')
        }
        const ownerPath = validateTreeFile(canonicalTree, row.ownerPath)
        validateTreeFile(canonicalTree, row.contractPath)
        validateTreeFile(canonicalTree, row.testPath)
        const verificationPath = validateTreeFile(canonicalTree, row.verificationPath)
        if (!readFileSync(ownerPath, 'utf8').includes(row.anchor)) throw new Error('candidate scope anchor was not found in its owner file')
        if (!readFileSync(verificationPath, 'utf8').includes(row.verificationCommand)) {
            throw new Error('candidate scope command was not found in its verification file')
        }
        for (const path of [row.ownerPath, row.contractPath, row.testPath, row.verificationPath]) {
            if (!transcriptPaths.includes(path)) throw new Error('candidate scope file lacks native transcript evidence')
        }
        return { ...row }
    })
    if (new Set(scopeEvidence.map((row) => row.anchor)).size !== scopeEvidence.length) {
        throw new Error('candidate navigation scope anchors must be unique')
    }
    return {
        located: payload.located,
        exactCommand: payload.exactCommand,
        openedPaths: reportedOpenedPaths,
        scopeEvidence,
    }
}

function signedRow(privateKey, row) {
    const payload = { harness: row.harness, scope: row.scope, receipt: row.receipt }
    return { ...row, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') }
}

function directoryDigest(root, current = root, rows = []) {
    for (const entry of readdirSync(current).sort()) {
        const path = join(current, entry)
        const relativePath = relative(root, path).split(sep).join('/')
        const stat = lstatSync(path)
        if (stat.isDirectory()) {
            rows.push(['directory', relativePath])
            directoryDigest(root, path, rows)
        } else if (stat.isFile()) {
            rows.push(['file', relativePath, sha256(readFileSync(path))])
        } else {
            rows.push(['other', relativePath])
        }
    }
    return sha256(JSON.stringify(rows))
}

function scriptRuntimeExecutables(binary) {
    const descriptor = openSync(binary, 'r')
    try {
        const header = Buffer.alloc(128)
        const bytes = readSync(descriptor, header, 0, header.length, 0)
        const shebang = header.subarray(0, bytes).toString('utf8').split('\n', 1)[0]
        return shebang.startsWith('#!') && /(?:\/|\s)node(?:\s|$)/.test(shebang)
            ? [process.execPath, '/usr/bin/env']
            : []
    } finally {
        closeSync(descriptor)
    }
}

function claudeIcuDataPaths() {
    if (process.platform !== 'darwin') return []
    try {
        const matches = readdirSync(CLAUDE_ICU_DATA_DIRECTORY).filter((name) => /^icudt\d+l\.dat$/.test(name))
        if (matches.length !== 1) return null
        const path = join(CLAUDE_ICU_DATA_DIRECTORY, matches[0])
        return lstatSync(path).isFile() ? [realpathSync(path)] : null
    } catch {
        return null
    }
}

function confinementUnavailable(sandbox, prepared) {
    const runtimeMarker = join(prepared.writable, 'confinement-runtime')
    const sentinel = prepared.forbiddenRoots.find((path) => path.endsWith('confinement-sentinel'))
    if (sentinel === undefined) return 'confinement control is unavailable'
    const read = (profilePath, path) => spawnSync(
        sandbox,
        ['-f', profilePath, '/bin/cat', '--', path],
        { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 5_000 },
    )
    try {
        writeFileSync(runtimeMarker, 'synthetic runtime marker\n', { mode: 0o600 })
        if (read(prepared.profiles.candidate, runtimeMarker).status !== 0) return 'confinement runtime launch is unavailable'
        if (read(prepared.profiles.candidate, join(sentinel, 'credential-store')).status === 0) return 'confinement candidate did not refuse the host control'
        if (read(prepared.brokenProfile, join(sentinel, 'credential-store')).status !== 0) return 'broken confinement control is unavailable'
        return null
    } catch {
        return 'confinement control is unavailable'
    } finally {
        rmSync(runtimeMarker, { force: true })
    }
}

async function runHarness(input, harness) {
    const prepared = input.prepared.harnesses[harness]
    const requestedBinary = input.binaries[harness]
    const requestedSandbox = input.binaries.sandbox
    const prompt = input.prompt
    const issuedAt = input.issuedAt
    const resolutionEnvironment = { ...process.env, ...input.environment }
    const resolveExecutable = (executable) => {
        try {
            return executable.includes(sep)
                ? realpathSync(executable)
                : realpathSync(execFileSync('which', [executable], { env: resolutionEnvironment, encoding: 'utf8' }).trim())
        } catch {
            return null
        }
    }
    const binary = resolveExecutable(requestedBinary)
    const sandbox = resolveExecutable(requestedSandbox)
    const literalReadPaths = harness === 'claude' ? claudeIcuDataPaths() : []
    if (binary === null || sandbox === null) {
        return { harness, scope: input.scope, status: 'unavailable', reason: 'required harness executable is unavailable' }
    }
    if (literalReadPaths === null) return { harness, scope: input.scope, status: 'unavailable', reason: 'required Claude ICU data is unavailable' }
    const unavailable = (reason) => ({ harness, scope: input.scope, status: 'unavailable', reason })
    const confinementReason = confinementUnavailable(sandbox, prepared)
    if (confinementReason !== null) return unavailable(confinementReason)
    const cleanupBefore = directoryDigest(prepared.writable)
    const runOne = async (kind, tree) => {
        const runtime = join(prepared.writable, kind)
        mkdirSync(runtime, { recursive: true, mode: 0o700 })
        try {
            const emptyConfig = join(runtime, 'mcp.json')
            const lastMessage = join(runtime, 'last-message.json')
            writeFileSync(emptyConfig, '{"mcpServers":{}}\n', { mode: 0o600 })
            const inner = harness === 'codex'
                ? ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C', tree, '--json', '-o', lastMessage, prompt]
                : ['-p', '--restricted', '--setting-sources', 'project', '--permission-mode', 'plan', '--permission-prompts', 'none', '--allowedTools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', emptyConfig, '--no-session-persistence', '--output-format', 'stream-json', '--verbose', prompt]
            const environment = boundedEnvironment(harness, runtime, input.environment)
            const invocationProfile = join(runtime, 'profile.sb')
            const peer = kind === 'candidate' ? prepared.brokenControl : prepared.candidate
            const harnessExecutables = harness === 'codex' ? ['/bin/zsh', '/bin/cat', '/usr/bin/find'] : []
            writeFileSync(invocationProfile, profile({
                tree,
                writable: runtime,
                forbidden: [...prepared.forbiddenRoots, peer],
                executablePaths: [binary, ...scriptRuntimeExecutables(binary), ...harnessExecutables],
                literalReadPaths,
            }), { mode: 0o600 })
            const execution = await execute({
                executable: sandbox,
                arguments_: ['-f', invocationProfile, binary, ...inner],
                cwd: tree,
                environment,
                timeoutMs: input.timeoutMs,
                maxOutputBytes: input.maxOutputBytes,
            })
            const payloadOutput = harness === 'codex' && existsSync(lastMessage)
                ? readFileSync(lastMessage, 'utf8')
                : execution.output
            return { command: displayCommand(harness, prompt), execution, payloadOutput }
        } finally {
            rmSync(runtime, { force: true, recursive: true })
        }
    }
    let candidate
    try {
        candidate = await runOne('candidate', prepared.candidate)
    } catch {
        return unavailable('candidate execution evidence is unavailable')
    }
    if (SECRET_PATTERN.test(candidate.execution.output) || SECRET_PATTERN.test(candidate.payloadOutput)) {
        return unavailable('unsafe harness output withheld')
    }
    if (candidate.execution.status !== 0) {
        const reason = /auth|login|api.?key|credential/i.test(`${candidate.execution.output}\n${candidate.payloadOutput}`)
            ? 'authentication unavailable within the bounded environment'
            : `candidate navigation failed within the bounded environment (exit ${candidate.execution.status})`
        return unavailable(reason)
    }
    let transcriptPaths
    try {
        transcriptPaths = nativeOpenedPaths(harness, candidate.execution.output, prepared.candidate)
    } catch {
        return unavailable('native opened-path transcript is unavailable')
    }
    if (transcriptPaths.length === 0) {
        return unavailable('native opened-path transcript is unavailable')
    }
    let candidatePayload
    try {
        candidatePayload = validatedCandidate(
            parsePayload(harness, candidate.payloadOutput),
            prepared.candidate,
            input.scope,
            transcriptPaths,
        )
    } catch {
        return unavailable('candidate navigation evidence is unavailable')
    }
    if (SECRET_PATTERN.test(JSON.stringify(candidatePayload))) {
        return unavailable('unsafe harness output withheld')
    }
    let control
    try {
        control = await runOne('broken-control', prepared.brokenControl)
    } catch {
        return unavailable('broken-control execution evidence is unavailable')
    }
    if (SECRET_PATTERN.test(control.execution.output) || SECRET_PATTERN.test(control.payloadOutput)) {
        return unavailable('unsafe harness output withheld')
    }
    if (control.execution.status !== 0) {
        const reason = /auth|login|api.?key|credential/i.test(`${control.execution.output}\n${control.payloadOutput}`)
            ? 'authentication unavailable within the bounded environment'
            : 'broken-control execution evidence is unavailable'
        return unavailable(reason)
    }
    try {
        const controlPayload = parsePayload(harness, control.payloadOutput)
        if (controlPayload?.controlMarker !== input.prepared.controlMarker) {
            throw new Error('broken control marker does not match')
        }
    } catch {
        return unavailable('broken-control navigation evidence is unavailable')
    }
    const normalizedControl = JSON.stringify({
        controlMarkerDetected: true,
        harnessCommand: control.command,
        harnessExitStatus: control.execution.status,
    })
    const validation = spawnSync(process.execPath, ['-e', CONTROL_VALIDATOR_SOURCE], {
        input: normalizedControl,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    if (validation.status !== 1 || validation.stderr.trim() !== CONTROL_DETECTOR_CODE) {
        return unavailable('broken-control validator evidence is unavailable')
    }
    const cleanupAfter = directoryDigest(prepared.writable)
    if (cleanupBefore !== cleanupAfter) return unavailable('runtime cleanup evidence is unavailable')
    const validatorCommand = [process.execPath, '-e', CONTROL_VALIDATOR_SOURCE].map(shellWord).join(' ')
    const receipt = {
        candidateCommit: input.prepared.commit,
        issuedAt,
        scopeSha256: sha256(`${input.scope.join('\n')}\n`),
        bounds: { maxSeconds: input.timeoutMs / 1_000, maxOutputBytes: input.maxOutputBytes },
        openedPaths: candidatePayload.openedPaths,
        differential: 'The candidate completed without the adjacent marker; the broken control produced the exact marker and validator refusal.',
        cleanup: { before: cleanupBefore, after: cleanupAfter },
        candidate: {
            command: candidate.command,
            exitStatus: candidate.execution.status,
            transcriptSha256: sha256(JSON.stringify(candidatePayload)),
        },
        brokenControl: {
            command: validatorCommand,
            exitStatus: validation.status,
            transcriptSha256: sha256(normalizedControl),
            detectorCode: CONTROL_DETECTOR_CODE,
            harnessCommand: control.command,
            harnessExitStatus: control.execution.status,
        },
    }
    return signedRow(input.privateKey, { harness, scope: input.scope, receipt })
}

export async function runNavigationProbe(input) {
    const timeoutMs = input.timeoutMs ?? MAX_TIMEOUT_MS
    const maxOutputBytes = input.maxOutputBytes ?? MAX_OUTPUT_BYTES
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`timeout cannot exceed ${MAX_TIMEOUT_MS}ms`)
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_OUTPUT_BYTES) throw new Error(`output limit cannot exceed ${MAX_OUTPUT_BYTES} bytes`)
    if (!Array.isArray(input.scope) || input.scope.some((item) => typeof item !== 'string') || new Set(input.scope).size !== input.scope.length) throw new Error('scope must contain unique strings')
    if (JSON.stringify(input.scope) !== JSON.stringify(input.prepared.manifest.navigationScope)) {
        throw new Error('scope must equal the review manifest navigation scope')
    }
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') throw new Error('prompt must be non-empty')
    for (const name of Object.keys(input.environment ?? {})) {
        if (!ALLOWED_ENVIRONMENT.has(name)) throw new Error(`environment name is not allow-listed: ${name}`)
    }
    if (SECRET_PATTERN.test(input.prompt) || input.scope.some((item) => SECRET_PATTERN.test(item))) {
        throw new Error('navigation request contains secret-shaped input')
    }
    const issuedAt = (input.now?.() ?? new Date()).toISOString()
    const shared = { ...input, timeoutMs, maxOutputBytes, issuedAt }
    return await Promise.all(['codex', 'claude'].map((harness) => runHarness(shared, harness)))
}

export function renderNavigationEvidence(fixedPoint, navigation) {
    return `# Navigation evidence\n\n\`\`\`docs-evidence\n${JSON.stringify({ fixedPoint, navigation }, null, 2)}\n\`\`\`\n`
}

function argumentValue(arguments_, flag) {
    const positions = arguments_.flatMap((value, index) => value === flag ? [index] : [])
    if (positions.length !== 1 || positions[0] === arguments_.length - 1 || arguments_[positions[0] + 1].startsWith('--')) {
        throw new Error(`${flag} is required exactly once`)
    }
    return arguments_[positions[0] + 1]
}

async function main() {
    const arguments_ = process.argv.slice(2)
    if (arguments_.length === 1 && arguments_[0] === '--help') {
        process.stdout.write('Usage: node scripts/navigation-probe.mjs --write-evidence <file> --review-manifest <file> --base <commit> --head <commit>\n')
        return
    }
    const evidencePath = resolve(argumentValue(arguments_, '--write-evidence'))
    const reviewManifest = resolve(argumentValue(arguments_, '--review-manifest'))
    const base = argumentValue(arguments_, '--base')
    const head = argumentValue(arguments_, '--head')
    const root = mkdtempSync(join(tmpdir(), 'cockpit-navigation-'))
    try {
        const prepared = await prepareNavigationProbe({ repository: process.cwd(), reviewManifest, base, head, destination: root })
        const { privateKey, publicKey } = generateKeyPairSync('ed25519')
        const scope = prepared.manifest.navigationScope
        const navigation = await runNavigationProbe({
            prepared,
            binaries: { sandbox: '/usr/bin/sandbox-exec', codex: 'codex', claude: 'claude' },
            privateKey,
            prompt: [
                'Inspect only this public tree.',
                'If .navigation-control exists, return only JSON as {"controlMarker":"<its exact contents>"}.',
                'Otherwise read every file used as evidence and return only JSON with exactly these fields:',
                '{"located":[{"kind":"purpose","path":"<path>"},{"kind":"contract","path":"<path>"},{"kind":"implementation","path":"<path>"},{"kind":"test","path":"<path>"},{"kind":"command","path":"<path>"}],"exactCommand":"<targeted command copied from the reported command file>","openedPaths":["<every content-read path>"],"scopeEvidence":[{"id":"<scope id>","ownerPath":"<implementation owner>","contractPath":"<public contract>","testPath":"<RED-capable test>","verificationPath":"<file containing the command>","verificationCommand":"<exact command>","anchor":"<exact owner text>"}]}.',
                `Return one scopeEvidence row in this exact order for ${JSON.stringify(scope)}.`,
                'Use native Read calls when available. If only bounded shell reads are available, use exactly cat -- RELATIVE_PATH with one file per call.',
                'Each reported path must be relative to this tree.',
            ].join(' '),
            scope,
        })
        mkdirSync(dirname(evidencePath), { recursive: true })
        writeFileSync(evidencePath, renderNavigationEvidence(prepared.base, navigation), { mode: 0o600 })
        writeFileSync(`${evidencePath}.public.pem`, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
    } finally {
        rmSync(root, { force: true, recursive: true })
    }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main().catch((error) => {
        console.error(`navigation-probe: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
    })
}
