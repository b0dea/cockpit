'use strict'

// Supervises one fenced action for the executor (packages/cockpit/src/environment-exec/execute.ts) so
// that an attempt whose executor died can still be ended and proven gone by `repairFencedExecution`.
//
// argv: <config>, base64url JSON { command, args, argv0, cwd, spawnNotAfter, fence }.
// fd 3 to the executor: 'READY\n' once the repair socket listens; 'EXPIRED\n' before exiting when the
// action was never released because its spawn deadline passed, the executor cancelled it, or a stop
// arrived first.
// stdin from the executor: one release line, 'GO' or 'CANCEL', then the attempt id and the device and
// inode of the active marker and its parent directory that the executor published. Anything else exits.
// repair socket: a client that writes the attempt id is answered { attemptId, supervisorPid } and the
// action is stopped.
// exit code: the action's exit code, or 125 when the fence could not be kept (protocol violation, the
// runner lost, or no durable 'terminated' marker). The supervisor exits only after the action's process
// group is gone and the marker reads 'terminated', so that marker proves nothing of the attempt runs.
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { readFenceMarkerFile, replaceApprovedActiveMarker } = require('./fence-marker.cjs')

const FENCE_LOST = 125
const GROUP_EXIT_WAIT_MS = 2000
const RUNNER = path.join(__dirname, 'fenced-group-runner.cjs')

const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const { fence } = config

let action
let approved
let started = false
let finished = false
let terminating = false
let expired = false
let stopRequested = false
let actionCode = 1

const groupGone = pid => {
    try { process.kill(-pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
}
const removeSocket = () => {
    try { fs.unlinkSync(fence.socketPath) } catch { /* already absent; repair checks absence itself */ }
}
const abandon = () => {
    removeSocket()
    process.exit(FENCE_LOST)
}
const publishTerminated = () => approved !== undefined && replaceApprovedActiveMarker(
    fence, { ...approved, supervisorPid: process.pid }, 'supervisor',
    { status: 'terminated', finishedAt: new Date().toISOString() },
)

const server = createServer(socket => {
    let request = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
        request += chunk
        if (request.length > 256) return socket.destroy()
        if (!request.includes('\n')) return
        if (request.trim() !== fence.attemptId) return socket.destroy()
        socket.end(`${JSON.stringify({ attemptId: fence.attemptId, supervisorPid: process.pid })}\n`)
        terminate()
    })
})

function finish(deadline) {
    if (finished) return
    if (action && !groupGone(action.pid)) {
        if (Date.now() >= deadline) return abandon()
        return setTimeout(() => finish(deadline), 10)
    }
    finished = true
    server.close()
    removeSocket()
    if (!publishTerminated()) process.exit(FENCE_LOST)
    if (expired) fs.writeSync(3, 'EXPIRED\n')
    process.exit(actionCode)
}

function terminate(code) {
    // A stop can be acknowledged before the release line arrives; that line must not start the action.
    if (!action) { stopRequested = true; return }
    if (terminating) return
    terminating = true
    actionCode = Number.isInteger(code) ? code : 1
    // A stop line that cannot be written means the action is unreachable; abandon exits with the fence-lost status.
    try { action.stdin.end('STOP\n') } catch { abandon() }
}

function startAction() {
    const runnerConfig = Buffer.from(JSON.stringify({
        command: config.command, args: config.args, argv0: config.argv0, cwd: config.cwd,
        spawnNotAfter: config.spawnNotAfter, fence, approved: { ...approved, supervisorPid: process.pid },
    })).toString('base64url')
    action = spawn(process.execPath, ['--', RUNNER, runnerConfig], {
        cwd: config.cwd, env: process.env, stdio: ['pipe', 'inherit', 'inherit', 'pipe'], detached: true,
    })
    let control = ''
    action.stdio[3].setEncoding('utf8')
    action.stdio[3].on('data', chunk => {
        control += chunk
        if (control.length > 64) return abandon()
        if (!control.includes('\n')) return
        if (control === 'EXPIRED\n') {
            expired = true
            return terminate(1)
        }
        const done = /^DONE (-?[0-9]+)\n$/.exec(control)
        if (!done) return abandon()
        terminate(Number(done[1]))
    })
    action.once('error', abandon)
    action.once('close', () => {
        if (!terminating) return abandon()
        finish(Date.now() + GROUP_EXIT_WAIT_MS)
    })
}

try { fs.unlinkSync(fence.socketPath) } catch (error) { if (error.code !== 'ENOENT') process.exit(FENCE_LOST) }
server.listen(fence.socketPath, () => fs.writeSync(3, 'READY\n'))

let release = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
    release += chunk
    if (started || !release.includes('\n')) return
    const fields = release.trim().split(' ')
    if (fields.length !== 6 || (fields[0] !== 'GO' && fields[0] !== 'CANCEL') || fields[1] !== fence.attemptId
        || fields.slice(2).some(value => !/^[0-9]+$/.test(value))) return abandon()
    approved = { markerDev: fields[2], markerIno: fields[3], parentDev: fields[4], parentIno: fields[5] }
    started = true
    if (stopRequested || fields[0] === 'CANCEL' || config.spawnNotAfter !== undefined && Date.now() > Date.parse(config.spawnNotAfter)) {
        expired = true
        return finish(Date.now() + GROUP_EXIT_WAIT_MS)
    }
    startAction()
})
process.stdin.on('end', () => {
    if (started) return
    // The executor died without releasing the action, so nothing ran. Its marker would otherwise name
    // this dead process for good, and repair could never finish. publishTerminated re-checks the marker.
    const read = readFenceMarkerFile(fence.markerPath)
    if (!read) return abandon()
    // A recoverer already settled this attempt (execute.ts writes this file), so no later cleanup will
    // come for the marker, and the state scan refuses a marker no attempt names.
    if (fs.existsSync(`${fence.socketPath}.settled`)) {
        if (read.value?.supervisorPid === process.pid) {
            try { fs.unlinkSync(fence.markerPath) } catch { /* the state scan reports what remains */ }
        }
        return abandon()
    }
    approved = read.identity
    started = true
    finish(Date.now())
})
process.on('SIGTERM', () => terminate(1))
process.on('SIGINT', () => terminate(1))
