'use strict'

// Anchored filesystem operations for packages/cockpit/src/generated-environment/transaction.ts:
// authenticated reads, adoption relocation, and the staged publication transaction (prepare,
// validate, publish, verify, commit, rollback). Runs from a staged snapshot, so it must stay
// self-contained.
//
// It is a separate process because Node has no openat(): the only way to pin a directory while
// operating inside it is to make it the working directory. Every walk moves the cwd one segment at
// a time and re-checks the entered directory's dev/ino, so a directory swapped for a symlink or
// another inode mid-walk is refused instead of followed, and every later operation is relative to
// the pinned directory. Changing the cwd of the cockpit process itself would redirect every
// concurrent relative path in it, and worker threads cannot change it at all.
//
// argv: <request JSON> [staged input paths...]. The request carries `version`, `nonce`, `action`,
// the expected `identity` of the starting cwd, the bounds in `limits`, and the action's fields.
// stdout: one JSON line { version: 1, nonce, action, kind: 'complete' | 'missing' | ..., ... }
// or { ..., kind: 'refusal', reason }. Any operation that cannot be proved exact is a refusal.

const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')

const c = fs.constants
const request = JSON.parse(process.argv[2])
const INPUT_ARGUMENT_OFFSET = 3
let limits

const parseLimits = value => {
    const keys = ['fileBytes', 'frameBytes', 'readBatchEntries', 'readBatchBytes', 'readBatchReceiptBytes', 'publicationGroups']
    if (!value || typeof value !== 'object' || Object.keys(value).length !== keys.length
        || !keys.every(key => Number.isSafeInteger(value[key]) && value[key] > 0)) throw new Error('limits')
    return value
}

const anchoredName = value => {
    if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..' || value.includes('/')
        || value.includes('\\') || value.includes('\0')) throw new Error('name')
    return value
}
const name = value => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 255 || Buffer.byteLength(value, 'utf8') > 255
        || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) || /[. ]$/.test(value)
        || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)) throw new Error('nonportable-name')
    return value
}
const safeSegments = (value, validate = name) => {
    if (!Array.isArray(value)) throw new Error('segments')
    return value.map(validate)
}

const same = (actual, expected) => actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === expected.dev && actual.ino === expected.ino
const identity = () => {
    const value = fs.lstatSync('.')
    if (!same(value, request.identity)) throw new Error('identity')
    return value
}
const currentDirectory = () => {
    const value = fs.lstatSync('.')
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('directory')
    return value
}
const syncDirectory = () => {
    const fd = fs.openSync('.', c.O_RDONLY)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const readLimit = value => {
    if (!Number.isSafeInteger(value) || value < 1 || value > limits.fileBytes) throw new Error('limit')
    return value
}
const writeExclusive = (target, bytes) => {
    const fd = fs.openSync(target, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600)
    try { fs.writeFileSync(fd, bytes) } finally { fs.closeSync(fd) }
}

const read = (target, maxBytes = limits.fileBytes, expected) => {
    maxBytes = readLimit(maxBytes)
    if (c.O_NOFOLLOW === undefined) throw new Error('no-follow')
    const fd = fs.openSync(target, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK)
    try {
        const status = fs.fstatSync(fd)
        if (!status.isFile() || status.size > maxBytes || expected && (status.dev !== expected.dev || status.ino !== expected.ino)) throw new Error('file')
        const chunks = []
        let total = 0
        const chunk = Buffer.allocUnsafe(65536)
        while (true) {
            const length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null)
            if (length === 0) break
            total += length
            if (total > maxBytes) throw new Error('limit')
            chunks.push(Buffer.from(chunk.subarray(0, length)))
        }
        const after = fs.fstatSync(fd)
        if (total !== status.size || after.dev !== status.dev || after.ino !== status.ino || after.size !== status.size
            || after.mtimeMs !== status.mtimeMs || after.ctimeMs !== status.ctimeMs) throw new Error('changed')
        return { bytes: Buffer.concat(chunks, total), status }
    } finally { fs.closeSync(fd) }
}
// Published files are committed, so they get the ordinary mode (after umask) a new file gets; 0600
// made every generated file unreadable to anything but its owner, containers included.
const copy = (source, target, expected) => {
    const value = read(source)
    if (digest(value.bytes) !== expected) throw new Error('digest')
    const fd = fs.openSync(name(target), c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o644)
    try {
        fs.writeFileSync(fd, value.bytes)
        fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
}
const hash = (target, validate = name) => digest(read(validate(target)).bytes)

// Walks that change the cwd. Each pushes { name, dev, ino, created } rows describing the chain it
// entered, so a later operation can walk the same chain and prove it reached the same inodes.
const walk = (segments, chain = [], validate = name) => {
    for (const raw of segments) {
        const segment = validate(raw)
        let created = false
        let before
        try { before = fs.lstatSync(segment) } catch (error) {
            if (error.code !== 'ENOENT') throw error
            fs.mkdirSync(segment, { mode: 0o700 })
            syncDirectory()
            created = true
            before = fs.lstatSync(segment)
        }
        if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('directory')
        process.chdir(segment)
        const after = fs.lstatSync('.')
        if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory() || after.isSymbolicLink()) throw new Error('walk')
        chain.push({ name: segment, dev: after.dev, ino: after.ino, created })
    }
    return chain
}
// Creates each missing segment, or enters one this batch already created (keyed by its path from
// the batch root in `created`). Any other existing directory is refused: it appeared after the
// caller observed the path as missing.
const walkCreating = (segments, chain, created, prefix) => {
    for (const raw of segments) {
        const segment = name(raw)
        const key = [...prefix, ...chain.map(entry => entry.name), segment].join('/')
        let before
        try { before = fs.lstatSync(segment) } catch (error) {
            if (error.code !== 'ENOENT') throw error
        }
        if (before) {
            const issued = created.get(key)
            if (!issued || !same(before, issued)) throw new Error('unexpected-directory')
            chain.push({ name: segment, dev: before.dev, ino: before.ino, created: false })
        } else {
            fs.mkdirSync(segment, { mode: 0o700 })
            before = fs.lstatSync(segment)
            if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('created-directory')
            created.set(key, { dev: before.dev, ino: before.ino })
            chain.push({ name: segment, dev: before.dev, ino: before.ino, created: true })
            syncDirectory()
        }
        process.chdir(segment)
        if (!same(fs.lstatSync('.'), before)) throw new Error('created-walk')
    }
    return chain
}
const walkSource = (segments, chain = []) => {
    for (const raw of segments) {
        const segment = anchoredName(raw)
        const before = fs.lstatSync(segment)
        if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('directory')
        process.chdir(segment)
        const after = fs.lstatSync('.')
        if (!same(after, before)) throw new Error('walk')
        chain.push({ name: segment, dev: after.dev, ino: after.ino })
    }
    return chain
}
const walkExpected = (chain, validate = name) => {
    const walked = []
    for (const expected of chain) {
        const segment = validate(expected.name)
        const before = fs.lstatSync(segment)
        if (!same(before, expected)) throw new Error('directory-identity')
        process.chdir(segment)
        const after = fs.lstatSync('.')
        if (!same(after, expected)) throw new Error('walk-identity')
        walked.push({ name: segment, dev: after.dev, ino: after.ino, created: false })
    }
    return walked
}
// Walks back up a chain to `start`, proving each parent and child are still the inodes walked down.
const verifySourceChain = (chain, start = request.identity) => {
    for (let index = chain.length - 1; index >= 0; index--) {
        process.chdir('..')
        const parent = fs.lstatSync('.')
        const expected = index === 0 ? start : chain[index - 1]
        if (!same(parent, expected)) throw new Error('parent-identity')
        const child = fs.lstatSync(anchoredName(chain[index].name))
        if (!same(child, chain[index])) throw new Error('child-identity')
    }
    if (!same(fs.lstatSync('.'), start)) throw new Error('start-identity')
}
const removeCreatedChain = (chain, start, validate = name) => {
    for (let index = chain.length - 1; index >= 0; index--) {
        process.chdir('..')
        const parent = fs.lstatSync('.')
        const expected = index === 0 ? start : chain[index - 1]
        if (!same(parent, expected)) throw new Error('parent-identity')
        const child = fs.lstatSync(validate(chain[index].name))
        if (!same(child, chain[index])) throw new Error('child-identity')
        if (chain[index].created) {
            try {
                fs.rmdirSync(validate(chain[index].name))
                syncDirectory()
            } catch (error) { if (error.code !== 'ENOTEMPTY') throw error }
        }
    }
    if (!same(fs.lstatSync('.'), start)) throw new Error('start-identity')
}
const removeCreatedDirectories = (entries, start) => {
    const base = process.cwd()
    const created = new Map()
    for (const entry of entries) {
        const names = []
        for (const [index, directory] of entry.chain.entries()) {
            names.push(directory.name)
            if (directory.created) created.set(names.join('/'), entry.chain.slice(0, index + 1))
        }
    }
    const chains = [...created.values()].sort((left, right) => right.length - left.length)
    for (const chain of chains) {
        process.chdir(base)
        const parents = walkExpected(chain.slice(0, -1))
        const child = chain[chain.length - 1]
        if (!same(fs.lstatSync(name(child.name)), child)) throw new Error('created-identity')
        try {
            fs.rmdirSync(name(child.name))
            syncDirectory()
        } catch (error) { if (error.code !== 'ENOTEMPTY') throw error }
        verifySourceChain(parents, start)
    }
    process.chdir(base)
    if (!same(fs.lstatSync('.'), start)) throw new Error('start-identity')
}

const state = target => {
    try {
        const status = fs.lstatSync(target)
        if (status.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(target), identity: { dev: status.dev, ino: status.ino } }
        if (status.isFile()) return { kind: 'file', sha256: hash(target), mode: status.mode & 511, identity: { dev: status.dev, ino: status.ino } }
        return { kind: 'other' }
    } catch (error) {
        if (error.code === 'ENOENT') return { kind: 'missing' }
        throw error
    }
}
const matches = (actual, expected) => actual.kind === expected.kind
    && (actual.kind !== 'file' || actual.sha256 === expected.sha256)
    && (actual.kind !== 'file' || expected.mode === undefined || actual.mode === expected.mode)
    && (actual.kind !== 'symlink' || actual.target === expected.target)
    && (actual.kind === 'missing' || !expected.identity || actual.identity.dev === expected.identity.dev && actual.identity.ino === expected.identity.ino)
const priorState = entry => ({ kind: entry.priorKind, sha256: entry.priorSha256, target: entry.priorTarget, mode: entry.priorMode, identity: entry.priorIdentity })
const postState = entry => entry.operation === 'write-file' ? { kind: 'file', sha256: entry.sha256 }
    : entry.operation === 'write-symlink' ? { kind: 'symlink', target: entry.target } : { kind: 'missing' }

const publishEntries = (entries, start = currentDirectory()) => {
    for (const entry of entries) {
        const chain = walkExpected(entry.chain)
        name(entry.name)
        if (!matches(state(entry.name), priorState(entry))) throw new Error('prior-state')
        if (entry.backup !== null && hash(entry.backup) !== entry.priorSha256) throw new Error('backup-digest')
        if (entry.operation === 'write-file') {
            name(entry.stage)
            if (hash(entry.stage) !== entry.sha256) throw new Error('stage-digest')
            fs.renameSync(entry.stage, entry.name)
        } else if (entry.operation === 'write-symlink') {
            name(entry.stage)
            if (fs.readlinkSync(entry.stage) !== entry.target) throw new Error('stage-target')
            fs.renameSync(entry.stage, entry.name)
        } else fs.unlinkSync(entry.name)
        syncDirectory()
        verifySourceChain(chain, start)
    }
}
const validateEntries = (entries, start = currentDirectory()) => {
    for (const entry of entries) {
        const chain = walkExpected(entry.chain)
        name(entry.name)
        if (!matches(state(entry.name), priorState(entry))) throw new Error('prior-state')
        if (entry.backup !== null && hash(entry.backup) !== entry.priorSha256) throw new Error('backup-digest')
        if (entry.operation === 'write-file' && hash(name(entry.stage)) !== entry.sha256) throw new Error('stage-digest')
        if (entry.operation === 'write-symlink' && fs.readlinkSync(name(entry.stage)) !== entry.target) throw new Error('stage-target')
        verifySourceChain(chain, start)
    }
}
const verifyEntries = (entries, start = currentDirectory()) => {
    for (const entry of entries) {
        const chain = walkExpected(entry.chain)
        name(entry.name)
        if (!matches(state(entry.name), postState(entry))) throw new Error('target-state')
        if (entry.backup !== null && hash(entry.backup) !== entry.priorSha256) throw new Error('backup-digest')
        verifySourceChain(chain, start)
    }
}

const respond = value => process.stdout.write(JSON.stringify({ version: 1, nonce: request.nonce, action: request.action, ...value }) + '\n')
const refuse = value => {
    respond({ kind: 'refusal', ...value })
    process.exit(0)
}

const readSource = entry => {
    const chain = []
    let before
    const filename = anchoredName(entry.name)
    try {
        walkSource(entry.segments, chain)
        before = fs.lstatSync(filename)
    } catch (error) {
        if (error.code === 'ENOENT') {
            verifySourceChain(chain)
            return { kind: 'missing' }
        }
        throw error
    }
    if (entry.action === 'read-entry' && before.isSymbolicLink()) {
        const target = fs.readlinkSync(filename)
        const current = fs.lstatSync(filename)
        if (!current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) throw new Error('source-changed')
        verifySourceChain(chain)
        return { kind: 'symlink', target, identity: { dev: before.dev, ino: before.ino } }
    }
    if (entry.action === 'read-entry' && !before.isFile()) {
        verifySourceChain(chain)
        return { kind: 'other' }
    }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('source')
    const value = read(filename, entry.maxBytes)
    if (value.status.dev !== before.dev || value.status.ino !== before.ino) throw new Error('source-identity')
    const current = fs.lstatSync(filename)
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) throw new Error('source-changed')
    verifySourceChain(chain)
    writeExclusive(entry.output, value.bytes)
    return {
        kind: entry.action === 'read-entry' ? 'file' : 'complete',
        identity: { root: request.identity, chain: chain.map(({ dev, ino }) => ({ dev, ino })), file: { dev: before.dev, ino: before.ino } },
        ...(entry.action === 'read-entry' ? { mode: before.mode & 511 } : {}),
        sha256: digest(value.bytes),
    }
}

const readBatch = () => {
    if (!Array.isArray(request.entries) || request.entries.length < 1 || request.entries.length > limits.readBatchEntries) throw new Error('batch')
    const requestedBytes = request.entries.reduce((total, entry) => total + readLimit(entry.maxBytes), 0)
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes > limits.readBatchBytes) throw new Error('batch-limit')
    const entries = []
    for (const entry of request.entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.nonce !== 'string'
            || !['read-file', 'read-entry'].includes(entry.action)) throw new Error('batch-entry')
        try {
            const result = readSource(entry)
            if (Buffer.byteLength(JSON.stringify({ version: 1, nonce: entry.nonce, action: entry.action, ...result }) + '\n') > limits.frameBytes) throw new Error('entry-frame')
            entries.push({ nonce: entry.nonce, action: entry.action, segments: entry.segments, name: entry.name, maxBytes: entry.maxBytes, ...result })
        } catch {
            // The parent accepts only this exact refusal frame, so the cause has no channel; it names the failed entry instead.
            refuse({ failedNonce: entry.nonce })
        }
    }
    const receipt = Buffer.from(JSON.stringify({ version: 1, nonce: request.nonce, action: request.action, kind: 'complete', entries }) + '\n')
    if (receipt.length > limits.readBatchReceiptBytes) throw new Error('receipt-limit')
    writeExclusive(request.receiptOutput, receipt)
    respond({ kind: 'complete', receiptBytes: receipt.length, receiptSha256: digest(receipt) })
}

const relocate = () => {
    const base = process.cwd()
    const destinationChain = []
    const sourceCapture = name('.cockpit-adopt-source-' + request.nonce)
    const destinationCapture = name('.cockpit-adopt-destination-' + request.nonce)
    const destinationPolicy = request.action === 'restore-file' ? anchoredName : name
    let sourceCapturePath
    let sourceMode
    let sourceCaptured = false
    let sourceRestored = false
    let originalRetired = false
    let destinationCreated = false
    let destinationQuarantined = false
    let destinationIdentity
    const restoreSource = () => {
        process.chdir(base)
        const chain = walkExpected(request.source.chain, anchoredName)
        const sourceName = anchoredName(request.source.name)
        if (state(sourceName).kind !== 'missing') throw new Error('source-recovery-occupied')
        fs.linkSync(sourceCapture, sourceName)
        const restored = fs.lstatSync(sourceName)
        const captured = fs.lstatSync(sourceCapture)
        if (!restored.isFile() || restored.isSymbolicLink() || restored.dev !== captured.dev || restored.ino !== captured.ino) throw new Error('source-recovery-identity')
        sourceRestored = true
        syncDirectory()
        verifySourceChain(chain)
    }
    const retireSourceCapture = (requireRestored, retired = () => {}) => {
        process.chdir(base)
        const chain = walkExpected(request.source.chain, anchoredName)
        const sourceName = anchoredName(request.source.name)
        const captured = fs.lstatSync(sourceCapture)
        if (!captured.isFile() || captured.isSymbolicLink() || captured.dev !== request.source.file.dev || captured.ino !== request.source.file.ino) throw new Error('source-retirement-identity')
        if (requireRestored) {
            const restored = fs.lstatSync(sourceName)
            if (!restored.isFile() || restored.isSymbolicLink() || restored.dev !== captured.dev || restored.ino !== captured.ino) throw new Error('source-retirement-public-identity')
        }
        fs.unlinkSync(sourceCapture)
        sourceCaptured = false
        retired()
        syncDirectory()
        verifySourceChain(chain)
    }
    const removeDestination = () => {
        process.chdir(base)
        const chain = walkExpected(destinationChain, destinationPolicy)
        const destinationName = destinationPolicy(request.destination.name)
        if (state(destinationCapture).kind !== 'missing') throw new Error('destination-recovery-capture')
        fs.renameSync(destinationName, destinationCapture)
        destinationQuarantined = true
        const captured = fs.lstatSync(destinationCapture)
        if (!captured.isFile() || captured.isSymbolicLink() || captured.dev !== destinationIdentity.dev || captured.ino !== destinationIdentity.ino) {
            fs.linkSync(destinationCapture, destinationName)
            fs.unlinkSync(destinationCapture)
            destinationQuarantined = false
            syncDirectory()
            throw new Error('destination-recovery-identity')
        }
        fs.unlinkSync(destinationCapture)
        destinationQuarantined = false
        destinationCreated = false
        syncDirectory()
        verifySourceChain(chain)
    }
    const regularWithIdentity = (status, expected) => status.isFile() && !status.isSymbolicLink() && status.dev === expected.dev && status.ino === expected.ino
    try {
        const sourceChain = walkExpected(request.source.chain, anchoredName)
        const sourceName = anchoredName(request.source.name)
        if (!regularWithIdentity(fs.lstatSync(sourceName), request.source.file)) throw new Error('source-identity')
        if (state(sourceCapture).kind !== 'missing') throw new Error('source-capture')
        sourceCapturePath = path.join(process.cwd(), sourceCapture)
        fs.renameSync(sourceName, sourceCapture)
        sourceCaptured = true
        syncDirectory()
        const captured = fs.lstatSync(sourceCapture)
        if (!regularWithIdentity(captured, request.source.file)) throw new Error('source-captured-identity')
        const source = read(sourceCapture, request.source.maxBytes, request.source.file)
        if (source.status.dev !== captured.dev || source.status.ino !== captured.ino || digest(source.bytes) !== request.source.sha256) throw new Error('source-digest')
        sourceMode = source.status.mode & 511
        verifySourceChain(sourceChain)

        process.chdir(base)
        walk(safeSegments(request.destination.segments, destinationPolicy), destinationChain, destinationPolicy)
        const destinationName = destinationPolicy(request.destination.name)
        if (state(destinationName).kind !== 'missing') throw new Error('destination-state')
        process.chdir(base)
        const linkSourceChain = walkExpected(request.source.chain, anchoredName)
        const currentCapture = read(sourceCapturePath, request.source.maxBytes, request.source.file)
        if (currentCapture.status.dev !== request.source.file.dev || currentCapture.status.ino !== request.source.file.ino
            || digest(currentCapture.bytes) !== request.source.sha256 || (currentCapture.status.mode & 511) !== sourceMode) throw new Error('source-capture-changed')
        verifySourceChain(linkSourceChain)
        process.chdir(base)
        walkExpected(destinationChain, destinationPolicy)
        fs.linkSync(sourceCapturePath, destinationName)
        destinationCreated = true
        destinationIdentity = { ...request.source.file }
        const destination = fs.lstatSync(destinationName)
        if (!regularWithIdentity(destination, destinationIdentity)) throw new Error('destination-linked-identity')
        process.chdir(base)
        const linkedSourceChain = walkExpected(request.source.chain, anchoredName)
        if (!regularWithIdentity(fs.lstatSync(sourceCapture), destinationIdentity)) throw new Error('source-linked-identity')
        verifySourceChain(linkedSourceChain)
        process.chdir(base)
        walkExpected(destinationChain, destinationPolicy)
        if (hash(destinationName, destinationPolicy) !== request.source.sha256 || (destination.mode & 511) !== sourceMode) throw new Error('destination-postimage')
        syncDirectory()
        verifySourceChain(destinationChain)

        process.chdir(base)
        const currentSourceChain = walkExpected(request.source.chain, anchoredName)
        if (state(sourceName).kind !== 'missing') throw new Error('source-postimage')
        if (!regularWithIdentity(fs.lstatSync(sourceCapture), destinationIdentity)) throw new Error('source-capture-identity')
        verifySourceChain(currentSourceChain)

        process.chdir(base)
        const currentDestinationChain = walkExpected(destinationChain, destinationPolicy)
        const currentDestination = fs.lstatSync(destinationName)
        if (!regularWithIdentity(currentDestination, destinationIdentity) || hash(destinationName, destinationPolicy) !== request.source.sha256
            || (currentDestination.mode & 511) !== sourceMode) throw new Error('destination-changed')
        verifySourceChain(currentDestinationChain)
        process.chdir(base)
        identity()
        retireSourceCapture(false, () => { originalRetired = true })
    } catch (error) {
        const describe = value => value instanceof Error ? value.message : String(value)
        const failure = describe(error)
        const recoveryFailures = []
        if (sourceCaptured) {
            try { restoreSource() } catch (recoveryError) { recoveryFailures.push('source:' + describe(recoveryError)) }
        }
        if (destinationCreated && !originalRetired) {
            try { removeDestination() } catch (recoveryError) { recoveryFailures.push('destination:' + describe(recoveryError)) }
        }
        if (sourceCaptured && sourceRestored && !destinationCreated) {
            try { retireSourceCapture(true) } catch (recoveryError) { recoveryFailures.push('source-retirement:' + describe(recoveryError)) }
        }
        if (originalRetired) recoveryFailures.push('source:original-retired')
        if (destinationChain.length > 0) {
            try {
                process.chdir(base)
                walkExpected(destinationChain, destinationPolicy)
                removeCreatedChain(destinationChain, request.identity, destinationPolicy)
            } catch (recoveryError) { recoveryFailures.push('directories:' + describe(recoveryError)) }
        }
        try {
            process.chdir(base)
            identity()
        } catch (recoveryError) { recoveryFailures.push('root:' + describe(recoveryError)) }
        if (recoveryFailures.length > 0) {
            const retained = []
            if (sourceCaptured) retained.push([...request.source.chain.map(entry => entry.name), sourceCapture].join('/'))
            if (destinationQuarantined) retained.push([...request.destination.segments, destinationCapture].join('/'))
            else if (destinationCreated) retained.push([...request.destination.segments, request.destination.name].join('/'))
            refuse({ reason: 'relocate-recovery-failed', failure, recoveryFailures, retained })
        }
        refuse({ reason: 'relocate-failed', failure })
    }
    respond({ kind: 'complete', sha256: request.source.sha256 })
}

// Stages one group: creates its missing parents, copies each staged input beside its target, and
// copies each prior file to a backup. Targets are never changed here, so an interrupted prepare
// leaves only stage and backup files. On failure it removes what this group created.
const prepareGroup = (group, base, created) => {
    const chain = []
    const prepared = []
    const attempted = []
    let start
    let final
    let groupPath
    try {
        process.chdir(base)
        if (!group || typeof group !== 'object' || typeof group.nonce !== 'string' || !Array.isArray(group.anchor) || !Array.isArray(group.entries)) throw new Error('batch-group')
        walkExpected(group.anchor)
        start = fs.lstatSync('.')
        if (!same(start, group.identity)) throw new Error('anchor-identity')
        walkCreating(safeSegments(group.segments), chain, created, group.anchor.map(entry => entry.name))
        final = fs.lstatSync('.')
        groupPath = process.cwd()
        const groupPrefix = [...group.anchor, ...chain].map(entry => entry.name)
        for (const [index, entry] of group.entries.entries()) {
            process.chdir(groupPath)
            const nested = []
            attempted.push({ index, chain: nested })
            nested.push(...walkExpected(entry.chain))
            walkCreating(safeSegments(entry.segments), nested, created, groupPrefix)
            const target = name(entry.name)
            const stage = name('.cockpit-stage-' + group.nonce + '-' + index)
            const backup = name('.cockpit-backup-' + group.nonce + '-' + index)
            const prior = state(target)
            if (!matches(prior, entry.expected)) throw new Error('prestate')
            let stageName = null
            if (entry.operation === 'write-file') {
                copy(process.argv[INPUT_ARGUMENT_OFFSET + entry.input], stage, entry.sha256)
                stageName = stage
            } else if (entry.operation === 'write-symlink') {
                fs.symlinkSync(entry.target, stage)
                stageName = stage
            } else if (entry.operation !== 'remove-file' && entry.operation !== 'remove-symlink') throw new Error('operation')
            let backupName = null
            if (prior.kind === 'file') {
                copy(target, backup, prior.sha256)
                backupName = backup
            }
            prepared.push({
                chain: nested, name: target, operation: entry.operation, sha256: entry.sha256 ?? null, target: entry.target ?? null,
                stage: stageName, backup: backupName, priorKind: prior.kind, priorSha256: prior.sha256 ?? null,
                priorTarget: prior.target ?? null, priorMode: prior.mode ?? null, priorIdentity: prior.identity ?? null,
            })
            verifySourceChain(nested, final)
        }
        process.chdir(groupPath)
        syncDirectory()
        verifySourceChain(chain, group.identity)
    } catch {
        if (!start) return { reason: 'prepare-failed' }
        try {
            if (groupPath && final) {
                for (const item of [...attempted].reverse()) {
                    process.chdir(groupPath)
                    walkExpected(item.chain)
                    fs.rmSync(name('.cockpit-stage-' + group.nonce + '-' + item.index), { force: true })
                    fs.rmSync(name('.cockpit-backup-' + group.nonce + '-' + item.index), { force: true })
                    syncDirectory()
                    removeCreatedChain(item.chain, final)
                }
            }
            process.chdir(base)
            walkExpected(group.anchor)
            if (chain.length > 0) {
                walkExpected(chain)
                removeCreatedChain(chain, group.identity)
            }
            if (!same(fs.lstatSync('.'), group.identity)) throw new Error('anchor-identity')
        } catch {
            // The receipt carries a fixed reason code that the parent matches exactly; cleanup failing is that code.
            return { reason: 'prepare-cleanup-failed' }
        }
        return { reason: 'prepare-failed' }
    }
    return { receipt: { nonce: group.nonce, identity: { dev: final.dev, ino: final.ino }, chain, entries: prepared } }
}

// Prepares every group in order from the transaction root. A later group may enter a directory an
// earlier group created. On a refusal the receipt still lists the groups already prepared, so the
// caller can roll them back.
const prepareBatch = () => {
    if (!Array.isArray(request.groups) || request.groups.length < 1 || request.groups.length > limits.publicationGroups) throw new Error('batch')
    const base = process.cwd()
    const created = new Map()
    const groups = []
    for (const group of request.groups) {
        const outcome = prepareGroup(group, base, created)
        // No process.exit here: this receipt can exceed a pipe buffer, and exiting would truncate it.
        if (!outcome.receipt) return respond({ kind: 'refusal', reason: outcome.reason, groups })
        groups.push(outcome.receipt)
    }
    respond({ kind: 'complete', groups })
}

// validate-batch and verify-batch only check. publish-batch validates every group before it
// renames any staged entry; commit-batch verifies every group before it retires any backup and
// reports a verification failure as `verify-failed`, so the caller knows nothing was retired.
const publicationBatch = () => {
    if (!Array.isArray(request.groups) || request.groups.length < 1 || request.groups.length > limits.publicationGroups) throw new Error('batch')
    const base = process.cwd()
    const eachGroup = operation => {
        for (const group of request.groups) {
            process.chdir(base)
            if (!group || typeof group !== 'object' || typeof group.nonce !== 'string' || typeof group.parent !== 'string'
                || !Array.isArray(group.chain) || !Array.isArray(group.entries)) throw new Error('batch-group')
            const chain = walkExpected(group.chain)
            if (!same(fs.lstatSync('.'), group.identity)) throw new Error('group-identity')
            operation(group)
            verifySourceChain(chain)
        }
    }
    if (request.action === 'validate-batch' || request.action === 'publish-batch') eachGroup(group => validateEntries(group.entries))
    else {
        try { eachGroup(group => verifyEntries(group.entries)) } catch (error) {
            if (request.action === 'commit-batch') refuse({ reason: 'verify-failed' })
            throw error
        }
    }
    if (request.action === 'publish-batch') eachGroup(group => publishEntries(group.entries))
    if (request.action === 'commit-batch') {
        eachGroup(group => {
            for (const entry of group.entries) {
                verifyEntries([entry], group.identity)
                const nested = walkExpected(entry.chain)
                if (entry.backup !== null) fs.unlinkSync(name(entry.backup))
                syncDirectory()
                verifySourceChain(nested, group.identity)
            }
        })
    }
    respond({ kind: 'complete', groups: request.groups.map(group => ({ nonce: group.nonce, parent: group.parent, kind: 'complete' })) })
}

// Restores one prepared or published group from its backups, then removes the directories it created.
const rollback = () => {
    const groupPath = process.cwd()
    for (const entry of request.entries) {
        process.chdir(groupPath)
        const nested = walkExpected(entry.chain)
        name(entry.name)
        if (entry.stage !== null) name(entry.stage)
        const current = state(entry.name)
        if (!matches(current, postState(entry)) && !matches(current, priorState(entry))
            || entry.backup !== null && hash(entry.backup) !== entry.priorSha256) throw new Error('recovery-state')
        verifySourceChain(nested, request.identity)
    }
    for (const entry of [...request.entries].reverse()) {
        process.chdir(groupPath)
        const nested = walkExpected(entry.chain)
        const current = state(entry.name)
        if (matches(current, postState(entry))) {
            if (current.kind !== 'missing') fs.unlinkSync(entry.name)
            if (entry.priorKind === 'file') {
                fs.renameSync(entry.backup, entry.name)
                fs.chmodSync(entry.name, entry.priorMode)
            } else if (entry.priorKind === 'symlink') fs.symlinkSync(entry.priorTarget, entry.name)
        } else if (entry.backup !== null) fs.unlinkSync(entry.backup)
        if (entry.stage !== null) fs.rmSync(entry.stage, { force: true })
        syncDirectory()
        verifySourceChain(nested, request.identity)
    }
    process.chdir(groupPath)
    removeCreatedDirectories(request.entries, request.identity)
    for (let index = request.chain.length - 1; index >= 0; index--) {
        const child = request.chain[index]
        process.chdir('..')
        const parent = fs.lstatSync('.')
        const expected = index === 0 ? request.start : request.chain[index - 1]
        if (!same(parent, expected)) throw new Error('parent-identity')
        if (!same(fs.lstatSync(name(child.name)), child)) throw new Error('child-identity')
        if (child.created) {
            try {
                fs.rmdirSync(name(child.name))
                syncDirectory()
            } catch (error) { if (error.code !== 'ENOTEMPTY') throw error }
        }
    }
    respond({ kind: 'complete' })
}

try {
    limits = parseLimits(request.limits)
    identity()
    if (request.action === 'read-batch') readBatch()
    else if (request.action === 'read-file' || request.action === 'read-entry') respond(readSource(request))
    else if (request.action === 'relocate-file' || request.action === 'restore-file') relocate()
    else if (request.action === 'prepare-batch') prepareBatch()
    else if (['validate-batch', 'publish-batch', 'verify-batch', 'commit-batch'].includes(request.action)) publicationBatch()
    else if (request.action === 'rollback') rollback()
    else throw new Error('action')
} catch {
    // The parent accepts only this fixed refusal frame, so the cause has no channel.
    respond({ kind: 'refusal', reason: 'operation-refused' })
}
