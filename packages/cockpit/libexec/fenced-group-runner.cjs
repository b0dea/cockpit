'use strict'

// Runs one fenced action as the leader of its own process group, under libexec/fenced-supervisor.cjs.
//
// argv: <config>, base64url JSON { command, args, argv0, cwd, spawnNotAfter, fence, approved }, where
// `approved` is the active marker the executor published ({ supervisorPid, markerDev, markerIno,
// parentDev, parentIno }).
// fd 3 to the supervisor: 'EXPIRED\n' when the spawn deadline had passed (the action never starts),
// otherwise exactly one 'DONE <exit code>\n' when the action closes.
// stdin from the supervisor: 'STOP\n' stops the group. Any other input, or stdin closing without it,
// means the supervisor is gone: the runner then records a 'terminating' marker naming its group, so
// a later repair can prove the group ended, before it stops the group itself.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { replaceApprovedActiveMarker, syncDirectory } = require('./fence-marker.cjs')

const STOP_KILL_DELAY_MS = 50

const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const { fence, approved } = config

// The group ends only through SIGKILL below, after the action had its SIGTERM; a stray terminal
// signal must not take the runner down and orphan the action outside its fence.
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})

const expired = config.spawnNotAfter !== undefined && Date.now() > Date.parse(config.spawnNotAfter)
const child = expired ? undefined : spawn(config.command, config.args, {
    argv0: config.argv0, cwd: config.cwd, env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
})
let reported = false
const report = code => {
    if (reported) return
    reported = true
    fs.writeSync(3, `DONE ${Number.isInteger(code) ? code : 1}\n`)
}
if (expired) fs.writeSync(3, 'EXPIRED\n')
else {
    child.once('error', () => report(1))
    child.once('close', code => report(code))
}

function publishTerminating() {
    if (!replaceApprovedActiveMarker(fence, approved, 'runner', { status: 'terminating', groupPid: process.pid })) return false
    try {
        try { fs.unlinkSync(fence.socketPath) } catch (error) { if (error.code !== 'ENOENT') return false }
        syncDirectory(path.dirname(fence.socketPath))
        return true
    } catch {
        // The 'terminating' marker is already durable; repair still waits for the socket to go.
        return false
    }
}

let stopping = false
let controlled = false
function stop(supervisorLost) {
    if (stopping) return
    if (supervisorLost) publishTerminating()
    stopping = true
    process.kill(-process.pid, 'SIGTERM')
    setTimeout(() => process.kill(-process.pid, 'SIGKILL'), STOP_KILL_DELAY_MS)
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
    input += chunk
    if (stopping || !input.includes('\n')) return
    if (input !== 'STOP\n') return stop(true)
    controlled = true
    stop(false)
})
process.stdin.on('end', () => { if (!controlled) stop(true) })
// Keeps the runner alive after the action closes, until the supervisor sends STOP.
setInterval(() => {}, 1000)
