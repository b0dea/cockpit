'use strict'

// Renders agent surfaces for packages/cockpit/src/surfaces/generator-adapter.ts by running the pinned
// Rulesync bundle (libexec/rulesync-generator.cjs) over each staged job. Runs from a staged snapshot,
// so it must stay self-contained.
//
// argv: <request JSON> <bundle path>. The request carries the pass root and its identity, the bundle
// digest and bound, the output `limits`, and one entry per job (target, features, staged roots and
// their identities, the warning source digest and the receipt path to write).
// For each job the worker writes a private receipt file ({ version, target, features, reportedPaths,
// actualFiles, warnings }) and reports on stdout one summary line { version: 1, jobs: [...] } holding
// each receipt's size and digest, or the job's error cause. The adapter reads every receipt back
// through a separate reader before it trusts any output.
//
// The bundle is hashed and then compiled from those same bytes, never re-read by path, so a bundle
// replaced between the check and the load is not what runs.
const fs = require('node:fs')
const crypto = require('node:crypto')
const Module = require('node:module')
const path = require('node:path')

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const safe = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every(part => part && part !== '.' && part !== '..')
const sameDirectory = (value, expected) => value.isDirectory() && !value.isSymbolicLink() && value.dev === expected.dev && value.ino === expected.ino

function authenticateBundle(bundlePath, expectedSha256, maxBytes) {
    const before = fs.lstatSync(bundlePath)
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || fs.constants.O_NOFOLLOW === undefined) throw new Error('rulesync bundle file changed')
    const fd = fs.openSync(bundlePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
        const opened = fs.fstatSync(fd)
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) throw new Error('rulesync bundle identity changed')
        const chunks = []
        const chunk = Buffer.allocUnsafe(65536)
        let total = 0
        while (true) {
            const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null)
            if (count === 0) break
            total += count
            if (total > maxBytes) throw new Error('rulesync bundle limit exceeded')
            chunks.push(Buffer.from(chunk.subarray(0, count)))
        }
        const after = fs.fstatSync(fd)
        if (total !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('rulesync bundle changed while reading')
        const bytes = Buffer.concat(chunks, total)
        if (digest(bytes) !== expectedSha256) throw new Error('rulesync bundle digest changed')
        return bytes
    } finally { fs.closeSync(fd) }
}

function loadAuthenticatedBundle(bundlePath, bytes) {
    const loaded = new Module(bundlePath, module)
    loaded.filename = bundlePath
    loaded.paths = Module._nodeModulePaths(path.dirname(bundlePath))
    loaded._compile(new TextDecoder('utf-8', { fatal: true }).decode(bytes), bundlePath)
    return loaded.exports
}

function inventory(root, limits) {
    const files = []
    let total = 0
    const walk = (current, prefix = '') => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (!safe(entry.name)) throw new Error('unsafe generated entry')
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name
            const target = path.join(current, entry.name)
            const status = fs.lstatSync(target)
            if (status.isSymbolicLink()) throw new Error('generated symbolic link')
            if (status.isDirectory()) walk(target, relative)
            else if (status.isFile()) {
                if (status.size > limits.fileMaxBytes) throw new Error('generated file limit exceeded')
                const bytes = fs.readFileSync(target)
                total += bytes.length
                if (files.length >= limits.outputMaxFiles || total > limits.outputMaxBytes) throw new Error('generated output limit exceeded')
                files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) })
            } else throw new Error('generated non-regular entry')
        }
    }
    walk(root)
    return files.sort((left, right) => left.path.localeCompare(right.path))
}

const describeEntries = entries => entries.map(({ label, reason }) => `'${label}' — ${reason}`).join('; ')
const quoteValues = values => values.map(value => JSON.stringify(value)).join(', ')
// Cockpit's wording names each value the person is trusting, and only settings that grant something:
// an empty list grants nothing, and warning about it on every sync taught people to skip the warning.
function warningMessage(entries) {
    const one = entries.length === 1
    return `Claude Code permissions: writing ${entries.length} trust-affecting ${one ? 'setting' : 'settings'} to .claude/settings.json; `
        + `review ${one ? 'it' : 'them'} as you would a hook because synced agent settings can widen filesystem access, approve project servers or run commands without asking. `
        + `${describeEntries(entries)}.`
}
// Rulesync's own spelling of its warning, which counts a present empty server list; it is accepted
// only to authenticate the generated settings and is replaced by cockpit's wording above.
function nativeWarningMessage(entries) {
    const one = entries.length === 1
    return `Claude Code permissions: writing ${entries.length} trust-affecting ${one ? 'setting' : 'settings'} to .claude/settings.json; `
        + `review ${one ? 'it' : 'them'} as you would a hook, especially if this permissions file came from '${['rulesync', 'fetch'].join(' ')}'. `
        + `${describeEntries(entries)}.`
}
const knownWarningEntries = [
    { label: 'permissions.additionalDirectories', reason: 'moves the boundary of what Claude Code may read and edit outside the project' },
    { label: 'enabledMcpjsonServers', reason: 'auto-approves the named servers in the project `.mcp.json`' },
]
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameStrings = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => typeof value === 'string' && value === right[index])
const stringList = value => Array.isArray(value) && value.every(item => typeof item === 'string')

// A captured warning is admitted only when it is exactly the warning the staged permissions source
// and the generated settings justify; anything else is treated as a generator diagnostic.
function authenticateWarnings({ job, captured, actualFiles }) {
    if (captured.length === 0) return []
    if (job.target !== 'claudecode' || job.warningSourceSha256 === null) return undefined
    const sourcePath = path.join(job.inputRoot, 'permissions.jsonc')
    if (!fs.existsSync(sourcePath)) return undefined
    const sourceBytes = fs.readFileSync(sourcePath)
    if (digest(sourceBytes) !== job.warningSourceSha256 || !actualFiles.some(file => file.path === '.claude/settings.json')) return undefined
    let source
    let settings
    try {
        source = JSON.parse(sourceBytes.toString('utf8'))
        settings = JSON.parse(fs.readFileSync(path.join(job.outputRoot, '.claude/settings.json'), 'utf8'))
    } catch {
        // Unparseable settings cannot justify the warning; the caller reports the warning text itself.
        return undefined
    }
    if (!record(source) || !record(settings)) return undefined
    const claude = source.claudecode
    if (!record(claude)) return undefined
    const sourceAdditionalDirectories = record(claude.permissions) ? claude.permissions.additionalDirectories : undefined
    const sourceEnabledMcpjsonServers = claude.enabledMcpjsonServers
    const additionalDirectories = record(settings.permissions) ? settings.permissions.additionalDirectories : undefined
    const enabledMcpjsonServers = settings.enabledMcpjsonServers
    if ((additionalDirectories !== undefined || sourceAdditionalDirectories !== undefined) && !sameStrings(additionalDirectories, sourceAdditionalDirectories)
        || (enabledMcpjsonServers !== undefined || sourceEnabledMcpjsonServers !== undefined) && !sameStrings(enabledMcpjsonServers, sourceEnabledMcpjsonServers)) return undefined
    const allow = record(settings.permissions) ? settings.permissions.allow : undefined
    const entries = []
    if (Array.isArray(additionalDirectories) && additionalDirectories.length > 0) entries.push(knownWarningEntries[0])
    if (Array.isArray(enabledMcpjsonServers)) entries.push(knownWarningEntries[1])
    if (entries.length === 0 || additionalDirectories !== undefined && !stringList(additionalDirectories)
        || enabledMcpjsonServers !== undefined && !stringList(enabledMcpjsonServers)
        || allow !== undefined && !stringList(allow)) return undefined
    if (captured.length !== 1 || captured[0] !== nativeWarningMessage(entries)) return undefined
    const granted = [
        ...additionalDirectories?.length ? [{ label: 'permissions.additionalDirectories', reason: `${knownWarningEntries[0].reason}: ${quoteValues(additionalDirectories)}` }] : [],
        ...enabledMcpjsonServers?.length ? [{ label: 'enabledMcpjsonServers', reason: `${knownWarningEntries[1].reason}: ${quoteValues(enabledMcpjsonServers)}` }] : [],
        ...allow?.length ? [{ label: 'permissions.allow', reason: `lets Claude Code run ${allow.length} command ${allow.length === 1 ? 'pattern' : 'patterns'} without asking; the file lists each one` }] : [],
    ]
    return granted.length === 0 ? []
        : [{ severity: 'warning', code: 'SURFACE_GENERATOR_TRUST_WARNING', target: job.target, path: '.claude/settings.json', message: warningMessage(granted) }]
}

function writeReceipt(target, value, limits) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
    if (bytes.length > limits.stdoutMaxBytes || fs.constants.O_NOFOLLOW === undefined) throw new Error('generator receipt limit exceeded')
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try { fs.writeFileSync(fd, bytes) } finally { fs.closeSync(fd) }
    return { bytes: bytes.length, sha256: digest(bytes) }
}

async function generateJob(job, bundleBytes, bundlePath, limits) {
    let failureCause = 'nonzero'
    const captured = []
    let capturedBytes = 0
    const stderr = []
    let stderrBytes = 0
    // Rulesync reports problems on stderr and console.warn; both are captured per job, bounded, and
    // turned into that job's failure instead of reaching cockpit's own output.
    const originalStderrWrite = process.stderr.write
    process.stderr.write = (chunk, encoding, callback) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined) : Buffer.from(chunk)
        const remaining = limits.stderrMaxBytes - stderrBytes
        if (remaining > 0) stderr.push(bytes.subarray(0, remaining))
        stderrBytes += bytes.length
        const done = typeof encoding === 'function' ? encoding : callback
        if (typeof done === 'function') queueMicrotask(done)
        return true
    }
    try {
        const cwdStatus = fs.lstatSync(job.cwd)
        const outputStatus = fs.lstatSync(job.outputRoot)
        if (!sameDirectory(cwdStatus, job.cwdIdentity) || !sameDirectory(outputStatus, job.identity)) throw new Error('job root identity changed')
        process.chdir(job.cwd)
        if (!sameDirectory(fs.lstatSync('.'), job.cwdIdentity)) throw new Error('job working directory changed')
        const root = loadAuthenticatedBundle(bundlePath, bundleBytes)
        if (typeof root.generate !== 'function') throw new Error('rulesync root generate export unavailable')
        const originalWarn = console.warn
        console.warn = (...args) => {
            const warning = args.length === 1 && typeof args[0] === 'string' ? args[0] : args.map(value => String(value)).join(' ')
            const bytes = Buffer.byteLength(warning)
            if (captured.length >= limits.warningCount || bytes > limits.warningBytes || capturedBytes + bytes > limits.warningTotalBytes) {
                failureCause = 'stderr'
                captured.splice(0, captured.length, 'surface generator emitted an unbounded diagnostic')
                return
            }
            captured.push(warning)
            capturedBytes += bytes
        }
        let result
        try {
            result = await root.generate({
                configPath: 'rulesync.jsonc', inputRoots: [job.inputRoot], outputRoots: [job.outputRoot], targets: [job.target],
                features: job.features, global: false, delete: false, silent: false,
            })
        } catch (error) {
            if (captured.length > 0) {
                failureCause = 'stderr'
                throw new Error(captured.join('\n'))
            }
            throw error
        } finally { console.warn = originalWarn }
        if (stderrBytes > 0) {
            failureCause = 'stderr'
            throw new Error(Buffer.concat(stderr).toString('utf8'))
        }
        if (result.sourceLoadFailed !== false || !Array.isArray(result.sourceLoadFailedFeatures) || result.sourceLoadFailedFeatures.length !== 0) {
            throw new Error('rulesync could not load every requested source')
        }
        const features = job.features.map(feature => ({ feature, count: result[`${feature}Count`], paths: result[`${feature}Paths`] }))
        const reportedPaths = [...new Set(features.flatMap(feature => feature.paths))].sort((left, right) => left.localeCompare(right))
        const actualFiles = inventory(job.outputRoot, limits)
        const warnings = authenticateWarnings({ job, captured, actualFiles })
        if (warnings === undefined) {
            failureCause = 'stderr'
            throw new Error(captured.join('\n'))
        }
        if (!sameDirectory(fs.lstatSync(job.outputRoot), job.identity)) throw new Error('output root identity changed')
        const receipt = writeReceipt(job.receiptOutput, { version: 1, target: job.target, features, reportedPaths, actualFiles, warnings }, limits)
        return { id: job.id, target: job.target, kind: 'complete', ...receipt }
    } catch (error) {
        if (stderrBytes > 0) failureCause = 'stderr'
        const message = stderrBytes > 0 ? Buffer.concat(stderr).toString('utf8') : String(error && (error.stack || error.message) || error)
        return { id: job.id, target: job.target, kind: 'error', cause: failureCause, message: message.slice(0, 1024) }
    } finally {
        process.stderr.write = originalStderrWrite
    }
}

async function main() {
    const request = JSON.parse(process.argv[2])
    const bundlePath = process.argv[3]
    const bundleBytes = authenticateBundle(bundlePath, request.bundleSha256, request.bundleMaxBytes)
    if (!sameDirectory(fs.lstatSync('.'), request.identity)) throw new Error('pass root identity changed')
    const summaries = []
    for (const job of request.jobs) {
        try {
            summaries.push(await generateJob(job, bundleBytes, bundlePath, request.limits))
        } finally {
            process.chdir(request.passRoot)
            if (!sameDirectory(fs.lstatSync('.'), request.identity)) throw new Error('pass root changed')
        }
    }
    process.stdout.write(`${JSON.stringify({ version: 1, jobs: summaries })}\n`)
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${String(error && (error.stack || error.message) || error)}\n`)
        process.exitCode = 1
    })
}

module.exports = { authenticateBundle, loadAuthenticatedBundle }
