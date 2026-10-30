'use strict'

// Reads back the surfaces the generator worker wrote, for packages/cockpit/src/surfaces/generator-adapter.ts.
// It is a separate process from libexec/surface-generator-worker.cjs so no code the Rulesync bundle
// loaded can shape what cockpit is told the output contains. Runs from a staged snapshot, so it must
// stay self-contained.
//
// argv: <request JSON> carrying the pass root and its identity, the output `limits`, and one entry
// per job (output root and its identity, the expected path set, the receipt path to write).
// Each job's receipt file holds { version: 1, files: [{ path, bytes, sha256, bytesBase64 }] }; stdout
// is one summary line { version: 1, jobs: [...] } with each receipt's size and digest or error cause.
// The walk moves the cwd through each directory and re-checks its identity, so a directory swapped
// for a link mid-walk is refused instead of followed.

const fs = require('node:fs')
const crypto = require('node:crypto')
const request = JSON.parse(process.argv[2])
const limits = request.limits
const c = fs.constants
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const safe = value => typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0')
const sameDirectory = (value, expected) => value.isDirectory() && !value.isSymbolicLink() && value.dev === expected.dev && value.ino === expected.ino
const samePaths = (left, right) => left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
const readFile = name => {
    const before = fs.lstatSync(name)
    if (!before.isFile() || before.isSymbolicLink() || before.size > limits.fileMaxBytes || c.O_NOFOLLOW === undefined) throw new Error('unsafe output file')
    const fd = fs.openSync(name, c.O_RDONLY | c.O_NOFOLLOW)
    try {
        const opened = fs.fstatSync(fd)
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limits.fileMaxBytes) throw new Error('output identity changed')
        const chunks = []; const chunk = Buffer.allocUnsafe(65536); let total = 0
        while (true) {
            const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, limits.fileMaxBytes - total + 1), null)
            if (count === 0) break
            total += count
            if (total > limits.fileMaxBytes) throw new Error('output file limit exceeded')
            chunks.push(Buffer.from(chunk.subarray(0, count)))
        }
        const after = fs.fstatSync(fd)
        if (total !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('output changed while reading')
        const bytes = Buffer.concat(chunks, total)
        return { bytes: bytes.length, sha256: digest(bytes), bytesBase64: bytes.toString('base64') }
    } finally { fs.closeSync(fd); }
}
const inventory = job => {
    const files = []; let total = 0
    const walk = (prefix = '') => {
        const parent = fs.lstatSync('.')
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('unsafe output directory')
        for (const entry of fs.readdirSync('.', { withFileTypes: true })) {
            if (!safe(entry.name)) throw new Error('unsafe output entry')
            const status = fs.lstatSync(entry.name)
            const relative = prefix ? prefix + '/' + entry.name : entry.name
            if (status.isSymbolicLink()) throw new Error('output symbolic link')
            if (status.isDirectory()) {
                process.chdir(entry.name)
                if (!sameDirectory(fs.lstatSync('.'), status)) throw new Error('output directory changed')
                walk(relative)
                process.chdir('..')
                if (!sameDirectory(fs.lstatSync('.'), parent) || !sameDirectory(fs.lstatSync(entry.name), status)) throw new Error('output directory identity changed')
            } else if (status.isFile()) {
                const file = readFile(entry.name)
                total += file.bytes
                if (files.length >= limits.outputMaxFiles || total > limits.outputMaxBytes) throw new Error('output set limit exceeded')
                files.push({ path: relative, ...file })
            } else throw new Error('output non-regular entry')
        }
    }
    process.chdir(job.outputRoot)
    if (!sameDirectory(fs.lstatSync('.'), job.identity)) throw new Error('output root identity changed')
    walk()
    if (!sameDirectory(fs.lstatSync('.'), job.identity)) throw new Error('output root changed')
    files.sort((left, right) => left.path.localeCompare(right.path))
    if (!samePaths(files.map(file => file.path), job.expected)) throw new Error('output path set changed')
    return files
}
const writeReceipt = (target, value) => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    if (bytes.length > limits.stdoutMaxBytes || c.O_NOFOLLOW === undefined) throw new Error('reader receipt limit exceeded')
    const fd = fs.openSync(target, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600)
    try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    return { bytes: bytes.length, sha256: digest(bytes) }
}
const passRoot = fs.lstatSync('.')
if (!sameDirectory(passRoot, request.identity)) throw new Error('pass root identity changed')
const summaries = []
for (const job of request.jobs) {
    try {
        const files = inventory(job)
        const receipt = writeReceipt(job.receiptOutput, { version: 1, files })
        summaries.push({ id: job.id, target: job.target, kind: 'complete', ...receipt })
    } catch (error) {
        summaries.push({ id: job.id, target: job.target, kind: 'error', cause: 'artifact', message: String(error && (error.stack || error.message) || error).slice(0, 4096) })
    } finally {
        process.chdir(request.passRoot)
        if (!sameDirectory(fs.lstatSync('.'), request.identity)) throw new Error('pass root changed')
    }
}
process.stdout.write(JSON.stringify({ version: 1, jobs: summaries }) + '\n')
