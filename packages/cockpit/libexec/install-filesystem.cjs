#!/usr/bin/env node

const {
    closeSync,
    constants,
    fstatSync,
    fsyncSync,
    lstatSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmdirSync,
    unlinkSync,
    writeSync,
} = require('node:fs')
const { basename, dirname, isAbsolute, join, normalize, relative, sep } = require('node:path')

const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_REQUEST_BYTES = 65_536
const MAX_FILE_BYTES = 1_048_576

function exactKeys(value, expected) {
    const actual = Object.keys(value).sort()
    const names = [...expected].sort()
    return actual.length === names.length && actual.every((name, index) => name === names[index])
}

function sameNode(left, right) {
    return left.dev === right.dev && left.ino === right.ino
}

function directory(path) {
    const status = lstatSync(path, { bigint: true })
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('unsafe directory')
    return status
}

function checkedRoot(value) {
    if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || dirname(value) === value || value.includes('\0')) {
        throw new Error('invalid root')
    }
    directory(value)
    return value
}

function checkedSegments(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((segment) => typeof segment !== 'string' || !SEGMENT.test(segment))) {
        throw new Error('invalid path segments')
    }
    return value
}

function child(root, segments) {
    const path = join(root, ...segments)
    const relation = relative(root, path)
    if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error('escaped path')
    return path
}

function syncDirectory(path) {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function ensureDirectory(root, segments) {
    let current = root
    let prior = directory(root)
    for (const segment of segments) {
        const next = join(current, segment)
        let created = false
        try { mkdirSync(next, { mode: 0o700 }); created = true } catch (error) {
            if (error.code !== 'EEXIST') throw error
        }
        if (created) syncDirectory(current)
        const status = directory(next)
        const parent = directory(current)
        if (!sameNode(parent, prior)) throw new Error('parent changed while creating directory')
        current = next
        prior = status
    }
    return { path: current, status: prior }
}

function writeAll(descriptor, bytes) {
    let offset = 0
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
}

function atomicFile(directoryPath, name, bytes, requestId) {
    if (!SEGMENT.test(name) || basename(name) !== name || bytes.length > MAX_FILE_BYTES) throw new Error('invalid file publication')
    const temporary = `.${name}.${requestId}.tmp`
    const temporaryPath = join(directoryPath, temporary)
    const target = join(directoryPath, name)
    const descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
        writeAll(descriptor, bytes)
        fsyncSync(descriptor)
    } finally {
        closeSync(descriptor)
    }
    try {
        linkSync(temporaryPath, target)
        unlinkSync(temporaryPath)
        syncDirectory(directoryPath)
    } catch (error) {
        try { unlinkSync(temporaryPath) } catch { /* The primary refusal preserves the publication failure. */ }
        throw error
    }
}

function readBounded(path) {
    const before = lstatSync(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_FILE_BYTES)) throw new Error('unsafe evidence file')
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        const opened = fstatSync(descriptor, { bigint: true })
        if (!sameNode(before, opened) || opened.nlink !== 1n || opened.size > BigInt(MAX_FILE_BYTES)) throw new Error('evidence changed before read')
        const bytes = readFileSync(descriptor)
        const after = fstatSync(descriptor, { bigint: true })
        const named = lstatSync(path, { bigint: true })
        if (!sameNode(opened, after) || !sameNode(opened, named) || named.nlink !== 1n || bytes.length !== Number(opened.size)) throw new Error('evidence changed during read')
        return bytes
    } finally { closeSync(descriptor) }
}

function acquire(request) {
    if (!exactKeys(request, ['version', 'requestId', 'operation', 'root', 'segments', 'ownerBase64'])) throw new Error('invalid acquire request')
    const root = checkedRoot(request.root)
    const segments = checkedSegments(request.segments)
    const owner = Buffer.from(request.ownerBase64, 'base64')
    if (owner.length < 1 || owner.length > MAX_FILE_BYTES || owner.toString('base64') !== request.ownerBase64) throw new Error('invalid owner evidence')
    const parent = ensureDirectory(root, segments.slice(0, -1))
    const lockPath = child(root, segments)
    try { mkdirSync(lockPath, { mode: 0o700 }) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const status = directory(lockPath)
        const entries = readdirSync(lockPath).sort()
        const ownerBytes = entries.length === 1 && entries[0] === 'owner.json' ? readBounded(join(lockPath, 'owner.json')) : undefined
        return { kind: 'exists', lock: { path: lockPath, dev: Number(status.dev), ino: Number(status.ino), entries, ownerBase64: ownerBytes?.toString('base64') ?? null } }
    }
    const status = directory(lockPath)
    if (!sameNode(directory(parent.path), parent.status)) throw new Error('lock parent changed during acquisition')
    try {
        atomicFile(lockPath, 'owner.json', owner, request.requestId)
        syncDirectory(parent.path)
        const named = directory(lockPath)
        if (!sameNode(status, named)) throw new Error('lock changed during owner publication')
        return { kind: 'acquired', lock: { path: lockPath, dev: Number(status.dev), ino: Number(status.ino), ownerBase64: owner.toString('base64') } }
    } catch (error) {
        try { rmdirSync(lockPath); syncDirectory(parent.path) } catch { /* Residue is intentionally left for explicit recovery. */ }
        throw error
    }
}

function release(request) {
    if (!exactKeys(request, ['version', 'requestId', 'operation', 'root', 'segments', 'dev', 'ino', 'ownerBase64', 'quarantine'])) throw new Error('invalid release request')
    const root = checkedRoot(request.root)
    const segments = checkedSegments(request.segments)
    if (typeof request.quarantine !== 'string' || !/^\.release-[a-zA-Z0-9._:-]+$/.test(request.quarantine)) throw new Error('invalid quarantine name')
    const lockPath = child(root, segments)
    const parentPath = join(root, ...segments.slice(0, -1))
    const status = directory(lockPath)
    if (Number(status.dev) !== request.dev || Number(status.ino) !== request.ino) throw new Error('lock identity changed')
    const owner = readBounded(join(lockPath, 'owner.json'))
    if (owner.toString('base64') !== request.ownerBase64) throw new Error('lock owner changed')
    const quarantinePath = join(parentPath, request.quarantine)
    renameSync(lockPath, quarantinePath)
    syncDirectory(parentPath)
    const moved = directory(quarantinePath)
    if (!sameNode(status, moved)) throw new Error('quarantine identity changed')
    const entries = readdirSync(quarantinePath).sort()
    if (entries.length !== 1 || entries[0] !== 'owner.json') return { kind: 'residue', path: quarantinePath, entries }
    if (readBounded(join(quarantinePath, 'owner.json')).toString('base64') !== request.ownerBase64) return { kind: 'residue', path: quarantinePath, entries }
    unlinkSync(join(quarantinePath, 'owner.json'))
    syncDirectory(quarantinePath)
    rmdirSync(quarantinePath)
    syncDirectory(parentPath)
    return { kind: 'released', path: lockPath }
}

function stamp(request) {
    if (!exactKeys(request, ['version', 'requestId', 'operation', 'root', 'segments', 'name', 'bytesBase64'])) throw new Error('invalid stamp request')
    const root = checkedRoot(request.root)
    const directoryPath = child(root, checkedSegments(request.segments))
    directory(directoryPath)
    const bytes = Buffer.from(request.bytesBase64, 'base64')
    if (bytes.length < 1 || bytes.toString('base64') !== request.bytesBase64) throw new Error('invalid stamp bytes')
    atomicFile(directoryPath, request.name, bytes, request.requestId)
    return { kind: 'stamped', path: join(directoryPath, request.name) }
}

function ensure(request) {
    if (!exactKeys(request, ['version', 'requestId', 'operation', 'root', 'segments'])) throw new Error('invalid ensure-directory request')
    const root = checkedRoot(request.root)
    const result = ensureDirectory(root, checkedSegments(request.segments))
    return { kind: 'complete', path: result.path, dev: Number(result.status.dev), ino: Number(result.status.ino) }
}

try {
    if (process.argv.length !== 3) throw new Error('expected exactly one request argument')
    const encoded = process.argv[2]
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new Error('missing or oversized request')
    const request = JSON.parse(encoded)
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.version !== 1 || !REQUEST_ID.test(request.requestId)) throw new Error('invalid request envelope')
    const result = request.operation === 'acquire' ? acquire(request)
        : request.operation === 'release' ? release(request)
            : request.operation === 'stamp' ? stamp(request)
                : request.operation === 'ensure-directory' ? ensure(request)
                    : (() => { throw new Error('unsupported operation') })()
    process.stdout.write(`${JSON.stringify({ version: 1, requestId: request.requestId, ...result })}\n`)
} catch (error) {
    process.stderr.write(`install-filesystem: ${error instanceof Error ? error.message : 'request failed'}\n`)
    process.exitCode = 2
}
