'use strict'

// Checks one host input of the generated environment (packages/cockpit/src/environment/generated-stack.ts):
// that a mount source has the declared type, or that a toolchain pin file holds the pinned version.
// Runs from a staged snapshot, so it must stay self-contained.
//
// argv: <target> <root JSON { path, dev, ino }> mount-lstat <file|directory>
//       <target> <root JSON { path, dev, ino }> toolchain-pin <observed> <pinned>
// Exits 0 when the input matches; throws (non-zero exit, message on stderr) otherwise.
//
// The probe walks from the root through the process cwd, pinning each directory before reading the
// next segment. Checking a complete path string once would let an intermediate symlink redirect a
// later read.
const fs = require('node:fs')
const path = require('node:path')

const TOOLCHAIN_PIN_MAX_BYTES = 1024

const [target, rootJson, kind, ...expected] = process.argv.slice(2)
const root = JSON.parse(rootJson)
const same = (status, identity) => status.dev === identity.dev && status.ino === identity.ino

if (fs.realpathSync(root.path) !== root.path) throw new Error('generated host input root changed')
process.chdir(root.path)
const base = fs.lstatSync('.')
if (!base.isDirectory() || base.isSymbolicLink() || !same(base, root)) throw new Error('generated host input root changed')
const relative = path.relative(root.path, target)
const segments = relative === '' ? [] : relative.split(path.sep)
if (path.isAbsolute(relative) || segments.some(segment => segment === '..' || segment === '.')) throw new Error('generated host input escaped its sibling')
const name = segments.pop() || '.'
for (const segment of segments) {
    const before = fs.lstatSync(segment)
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('generated host input crosses a symbolic or non-directory entry')
    process.chdir(segment)
    if (!same(fs.lstatSync('.'), before)) throw new Error('generated host input directory changed')
}
const entry = fs.lstatSync(name)
if (entry.isSymbolicLink()) throw new Error('generated host input is a symbolic entry')
if (kind === 'mount-lstat') {
    if (!(expected[0] === 'file' ? entry.isFile() : entry.isDirectory())) throw new Error('generated mount input type differs')
} else {
    if (!entry.isFile() || entry.size > TOOLCHAIN_PIN_MAX_BYTES || fs.constants.O_NOFOLLOW === undefined) throw new Error('generated toolchain input is not a bounded file')
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
        const before = fs.fstatSync(fd)
        if (!same(before, entry) || !before.isFile() || before.size > TOOLCHAIN_PIN_MAX_BYTES) throw new Error('generated toolchain input changed')
        const bytes = Buffer.alloc(TOOLCHAIN_PIN_MAX_BYTES + 1)
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0)
        const after = fs.fstatSync(fd)
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('generated toolchain input changed')
        const value = bytes.subarray(0, length).toString('utf8').trim()
        if (value !== expected[0] || value !== expected[1]) throw new Error('generated toolchain input differs from its pin')
    } finally { fs.closeSync(fd) }
}
