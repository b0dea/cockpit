'use strict'

// Reads and replaces the executor's fence marker: the small JSON file that records whether a fenced
// attempt is active, terminating, terminated or cancelled. The executor
// (packages/cockpit/src/environment-exec/execute.ts), libexec/fenced-supervisor.cjs and
// libexec/fenced-group-runner.cjs all read it here so they agree on what an authentic marker is.
//
// A marker is accepted only when the bytes came from the file that is named now: it is opened without
// following links, read whole within a small bound, and the descriptor, the named entry and the parent
// directory must still agree afterwards. Each marker records its own device and inode, so a copy or a
// marker renamed into place from elsewhere does not match the file it claims to be. This module
// decides nothing about status; callers check the fields they need.
const fs = require('node:fs')
const path = require('node:path')

const FENCE_MARKER_MAX_BYTES = 1024n

function readFenceMarkerFile(markerPath) {
    let fd
    try {
        fd = fs.openSync(markerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
        const before = fs.fstatSync(fd, { bigint: true })
        if (!before.isFile() || before.size > FENCE_MARKER_MAX_BYTES) return undefined
        const bytes = Buffer.alloc(Number(before.size) + 1)
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0)
        const after = fs.fstatSync(fd, { bigint: true })
        const named = fs.lstatSync(markerPath, { bigint: true })
        const parent = fs.lstatSync(path.dirname(markerPath), { bigint: true })
        if (count !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || !named.isFile() || named.dev !== before.dev || named.ino !== before.ino
            || !parent.isDirectory() || parent.isSymbolicLink()) return undefined
        return {
            value: JSON.parse(bytes.subarray(0, count).toString('utf8')),
            identity: {
                markerDev: String(before.dev), markerIno: String(before.ino),
                parentDev: String(parent.dev), parentIno: String(parent.ino),
            },
        }
    } catch {
        // Absent, unreadable and malformed markers all mean "no authentic marker"; every caller refuses
        // on that answer, and the fence protocol has no channel that could carry the cause further.
        return undefined
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd) } catch { /* the answer above does not depend on the descriptor */ }
    }
}

// The marker the executor published for this supervisor, unchanged since the executor named it in
// its release line. `approved` carries supervisorPid plus the four identity fields from that line.
function readApprovedActiveMarker(fence, approved) {
    const read = readFenceMarkerFile(fence.markerPath)
    if (!read) return undefined
    const { value: marker, identity } = read
    if (marker === null || typeof marker !== 'object'
        || marker.format !== 'cockpit-executor/v1' || marker.attemptId !== fence.attemptId
        || marker.supervisorPid !== approved.supervisorPid || marker.status !== 'active'
        || marker.markerDev !== approved.markerDev || marker.markerIno !== approved.markerIno
        || marker.parentDev !== approved.parentDev || marker.parentIno !== approved.parentIno
        || marker.markerDev !== identity.markerDev || marker.markerIno !== identity.markerIno
        || marker.parentDev !== identity.parentDev || marker.parentIno !== identity.parentIno) return undefined
    return marker
}

function syncDirectory(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

// Replaces the approved active marker with one carrying `fields`, durably. The replacement is written
// beside the marker under a name owned by `writer` and this process, and renamed over the marker only
// if the active marker is still the approved one, so a concurrent repair or cancel is never overwritten.
function replaceApprovedActiveMarker(fence, approved, writer, fields) {
    const current = readApprovedActiveMarker(fence, approved)
    if (!current) return false
    const temporary = `${fence.markerPath}.${writer}-${process.pid}`
    let fd
    try {
        fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
        const identity = fs.fstatSync(fd, { bigint: true })
        fs.writeFileSync(fd, `${JSON.stringify({ ...current, markerDev: String(identity.dev), markerIno: String(identity.ino), ...fields })}\n`)
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = undefined
        if (!readApprovedActiveMarker(fence, approved)) return false
        fs.renameSync(temporary, fence.markerPath)
        syncDirectory(path.dirname(fence.markerPath))
        return true
    } catch {
        // A replacement that did not land leaves the active marker in place, which repair reads as
        // "attempt may still run"; that is the fail-closed answer.
        return false
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd) } catch { /* the replacement already failed */ }
        try { fs.unlinkSync(temporary) } catch { /* renamed into place, or never created */ }
    }
}

module.exports = { readFenceMarkerFile, readApprovedActiveMarker, replaceApprovedActiveMarker, syncDirectory }
