#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const mechanism = {
    id: 'bounded-test-runner', module: 'scripts/run-tests.mjs', exports: ['readProcessTable', 'runTestsCli'],
}

const TARGETED_EXECUTION_TIMEOUT_MS = 825_000
const COMPLETE_EXECUTION_TIMEOUT_MS = 3_600_000
const TERMINATION_GRACE_MS = 10_000
const CLEANUP_TIMEOUT_MS = 5_000
const PROCESS_INVENTORY_TIMEOUT_MS = 5_000
const OBSERVATION_INTERVAL_MS = 2_000
const TEMP_CLEANUP_TIMEOUT_MS = 5_000
const FORBIDDEN_OPTIONS = /^(?:--?(?:watch|ui|open|standalone|shard|reporter|outputFile|minWorkers|pool|fileParallelism|passWithNoTests|bail|allowOnly|dangerouslyIgnoreUnhandledErrors))(?:=|$)/
const FILTER_OPTIONS = new Set(['-t', '--testNamePattern'])
const SIGNAL_STATUS = { SIGINT: 130, SIGTERM: 143 }
const IMMEDIATE_FAILURE_REPORTER = fileURLToPath(new URL('./immediate-failure-reporter.mjs', import.meta.url))
const EXPECTED_PLATFORM_SKIPS = process.platform === 'linux' ? [
    [/refuses ownership aliases of authenticated inputs on case-insensitive filesystems$/, 1],
    [/refuses ownership alias checks during a restored (?:input|root) namespace swap$/, 2],
] : []

const TEMP_CLEANUP_PROGRAM = `
import { lstatSync, rmSync } from 'node:fs'
const [path, expectedDevice, expectedInode] = process.argv.slice(1)
let observed
try { observed = lstatSync(path) } catch (error) {
  if (error?.code === 'ENOENT') process.exit(0)
  throw error
}
if (!observed.isDirectory() || observed.isSymbolicLink()
    || String(observed.dev) !== expectedDevice || String(observed.ino) !== expectedInode) process.exit(2)
rmSync(path, { recursive: true, force: false, maxRetries: 0 })
try { lstatSync(path); process.exit(3) } catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
`

const TEST_SUPERVISOR_PROGRAM = `
import { spawn } from 'node:child_process'
const [runner, ...arguments_] = process.argv.slice(1)
process.umask(0o022)
let completed = false
let terminating = false
const testProcess = spawn(process.execPath, [runner, ...arguments_], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (completed) process.exit(0)
})
testProcess.once('error', error => {
  completed = true
  process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) })
})
testProcess.once('close', (status, signal) => {
  completed = true
  process.send?.({ type: 'outcome', status, signal })
  if (terminating) process.exit(0)
})
process.on('message', message => {
  if (message?.type !== 'terminate') return
  terminating = true
  if (testProcess.exitCode === null && testProcess.signalCode === null) testProcess.kill(message.signal)
  else process.exit(0)
})
setInterval(() => {}, 1000)
`

function createInvocationTemp() {
    const path = mkdtempSync(join(tmpdir(), 'cockpit-test-run-'))
    const observed = lstatSync(path)
    if (!observed.isDirectory() || observed.isSymbolicLink()) throw new Error(`test temporary directory is invalid: ${path}`)
    return Object.freeze({ path, device: String(observed.dev), inode: String(observed.ino) })
}

function cleanupInvocationTemp(owned) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', TEMP_CLEANUP_PROGRAM,
        owned.path, owned.device, owned.inode], {
        encoding: 'utf8', env: {}, stdio: ['ignore', 'pipe', 'pipe'], timeout: TEMP_CLEANUP_TIMEOUT_MS,
        killSignal: 'SIGKILL', maxBuffer: 65_536,
    })
    if (result.error) return { cleaned: false, reason: result.error.message }
    if (result.signal || result.status !== 0) {
        return { cleaned: false, reason: result.signal ? `cleanup stopped by ${result.signal}` : `cleanup exited ${result.status}` }
    }
    const remains = existsSync(owned.path)
    return { cleaned: !remains, reason: remains ? 'temporary path still exists' : null }
}

function expectedSkips(root) {
    return [
        ...EXPECTED_PLATFORM_SKIPS,
        ...(!existsSync(resolve(root, 'internal'))
            ? [[/configures the site-specific list, having the material for it$/, 1]]
            : []),
    ]
}

function installedRunner(root) {
    const path = resolve(root, 'node_modules/vitest/vitest.mjs')
    if (!existsSync(path) || !lstatSync(path).isFile()) {
        throw new Error('installed Vitest executable is unavailable')
    }
    const canonical = realpathSync(path)
    if (!lstatSync(canonical).isFile()) throw new Error('installed Vitest executable is not a regular file')
    return canonical
}

function parseArguments(argv) {
    let filtered = false
    // Never more workers than cores: four workers on a two-core hosted runner ran the suite out of
    // memory and past its per-test timeouts.
    let maxWorkers = Math.min(4, availableParallelism())
    let hasMaxWorkers = false
    const arguments_ = []
    const positional = []
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--maxWorkers' || argument.startsWith('--maxWorkers=')) {
            if (hasMaxWorkers) throw new Error('test runner option was provided more than once: --maxWorkers')
            hasMaxWorkers = true
            const value = argument === '--maxWorkers' ? argv[++index] : argument.slice('--maxWorkers='.length)
            if (!value || !/^[1-4]$/.test(value)) {
                throw new Error('--maxWorkers must be an integer from 1 through 4')
            }
            maxWorkers = Number(value)
            continue
        }
        if (FORBIDDEN_OPTIONS.test(argument)) throw new Error(`test runner option is owned by the repository: ${argument}`)
        if (FILTER_OPTIONS.has(argument)) {
            if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error(`${argument} requires a pattern`)
            filtered = true
            arguments_.push(argument, argv[index + 1])
            index += 1
            continue
        }
        if (argument.startsWith('-')) throw new Error(`unsupported test runner option: ${argument}`)
        arguments_.push(argument)
        positional.push(argument)
    }
    return { arguments_, positional, filtered, complete: arguments_.length === 0, maxWorkers }
}

function boundedDuration(value, fallback, maximum, label) {
    const duration = value ?? fallback
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > maximum) {
        throw new Error(`${label} must be a non-negative integer no greater than ${maximum}`)
    }
    return duration
}

function signalProcess(pid, signal) {
    try {
        process.kill(pid, signal)
    } catch (error) {
        if (error?.code !== 'ESRCH') throw error
    }
}

export function readProcessTable() {
    const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: PROCESS_INVENTORY_TIMEOUT_MS,
    })
    if (result.error) throw new Error(`process inventory failed: ${result.error.message}`)
    if (result.signal || result.status !== 0) throw new Error('process inventory did not complete')
    const rows = new Map()
    for (const line of result.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
        if (!match) continue
        const pid = Number(match[1]); const ppid = Number(match[2]); const pgid = Number(match[3])
        if (pid > 0 && ppid >= 0 && pgid > 0) rows.set(pid, { pid, ppid, pgid, started: match[4] })
    }
    return rows
}

function sameProcess(row, identity) {
    return row?.pgid === identity.pgid && row.started === identity.started
}

function observeDescendants(rootPid, tracked, processInventory) {
    const rows = processInventory()
    const descendants = new Set()
    const root = rows.get(rootPid)
    const rootIdentity = tracked.get(rootPid)
    const rootMatches = root && (!rootIdentity ? tracked.size === 0 : sameProcess(root, rootIdentity))
    if (rootMatches) {
        descendants.add(rootPid)
        if (root.pgid === rootPid) {
            for (const row of rows.values()) if (row.pgid === root.pgid) descendants.add(row.pid)
        }
    }
    for (const [pid, identity] of tracked) if (sameProcess(rows.get(pid), identity)) descendants.add(pid)
    let changed = true
    while (changed) {
        changed = false
        for (const row of rows.values()) if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
            descendants.add(row.pid)
            changed = true
        }
    }
    for (const pid of descendants) {
        const row = rows.get(pid)
        if (row) tracked.set(row.pid, { pgid: row.pgid, started: row.started })
    }
    return rows
}

function liveProcesses(tracked, rows) {
    const processes = new Set()
    for (const [pid, identity] of tracked) {
        const row = rows.get(pid)
        if (sameProcess(row, identity) && pid !== process.pid) processes.add(pid)
    }
    return processes
}

function delay(milliseconds) {
    return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

async function stopSupervisor(child, cleanupMs) {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
        child.send({ type: 'terminate', signal: 'SIGKILL' })
    } catch {
        // The IPC channel is already closed, so signal the process directly; nothing else is left to report on cleanup.
        child.kill('SIGKILL')
        return
    }
    const deadline = Date.now() + Math.min(500, Math.max(100, cleanupMs))
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(10)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

function withinCleanupDeadline(cleanup, timeoutMs) {
    return new Promise(resolveCleanup => {
        const timeout = setTimeout(() => resolveCleanup({
            cleaned: false,
            error: new Error('Vitest descendant cleanup exceeded its independent deadline'),
        }), timeoutMs)
        void cleanup.then(result => {
            clearTimeout(timeout)
            resolveCleanup(result)
        })
    })
}

async function stopTree(rootPid, tracked, graceMs, cleanupMs, processInventory, initialSignal) {
    const processes = () => liveProcesses(tracked, observeDescendants(rootPid, tracked, processInventory))
    let anchorLost = false
    const descendants = () => {
        const active = processes()
        if (!active.delete(rootPid)) anchorLost = true
        return active
    }
    const initial = processes()
    if (!initial.has(rootPid)) return false
    initial.delete(rootPid)
    for (const pid of initial) signalProcess(pid, initialSignal)
    const gracefulDeadline = Date.now() + graceMs
    while (Date.now() < gracefulDeadline) {
        const active = descendants()
        if (active.size === 0) break
        for (const pid of active) signalProcess(pid, initialSignal)
        await delay(100)
    }
    if (anchorLost) return false
    for (const pid of descendants()) signalProcess(pid, 'SIGKILL')
    if (anchorLost) return false
    const cleanupDeadline = Date.now() + cleanupMs
    while (Date.now() < cleanupDeadline) {
        if (descendants().size === 0) break
        if (anchorLost) return false
        await delay(100)
    }
    if (descendants().size > 0 || anchorLost) return false
    signalProcess(rootPid, initialSignal)
    const anchorTimeoutMs = Math.min(5_000, Math.max(500, graceMs + cleanupMs))
    const anchorGraceDeadline = Date.now() + Math.floor(anchorTimeoutMs / 2)
    while (Date.now() < anchorGraceDeadline) {
        if (!liveProcesses(tracked, processInventory()).has(rootPid)) return true
        await delay(10)
    }
    if (liveProcesses(tracked, processInventory()).has(rootPid)) signalProcess(rootPid, 'SIGKILL')
    const anchorCleanupDeadline = Date.now() + Math.ceil(anchorTimeoutMs / 2)
    while (Date.now() < anchorCleanupDeadline) {
        if (!liveProcesses(tracked, processInventory()).has(rootPid)) return true
        await delay(10)
    }
    return false
}

async function killOwnedTree(child, rootIdentity, tracked, cleanupMs, processInventory) {
    if (!rootIdentity) {
        await stopSupervisor(child, cleanupMs)
        return {
            cleaned: false,
            error: new Error('root process identity was never observed; detached descendant cleanup is unconfirmed'),
        }
    }
    let rows
    try {
        rows = processInventory()
    } catch (error) {
        await stopSupervisor(child, cleanupMs)
        return {
            cleaned: false,
            error: new Error(`process inventory unavailable; detached descendant cleanup is unconfirmed: ${error instanceof Error ? error.message : String(error)}`),
        }
    }
    const root = rootIdentity ? rows.get(child.pid) : undefined
    const rootMatches = rootIdentity && sameProcess(root, rootIdentity)
    if (!rootMatches) {
        for (const pid of liveProcesses(tracked, rows)) signalProcess(pid, 'SIGKILL')
        await stopSupervisor(child, cleanupMs)
        return {
            cleaned: false,
            error: new Error('authenticated supervisor identity was lost; detached descendant cleanup is unconfirmed'),
        }
    }
    if (rootMatches && root.pgid === child.pid) signalProcess(-child.pid, 'SIGKILL')
    for (const pid of liveProcesses(tracked, rows)) signalProcess(pid, 'SIGKILL')
    const deadline = Date.now() + cleanupMs
    while (Date.now() < deadline) {
        try {
            if (liveProcesses(tracked, processInventory()).size === 0) return { cleaned: true, error: null }
        } catch (error) {
            return {
                cleaned: false,
                error: new Error(`process inventory unavailable; detached descendant cleanup is unconfirmed: ${error instanceof Error ? error.message : String(error)}`),
            }
        }
        await delay(100)
    }
    try {
        return { cleaned: liveProcesses(tracked, processInventory()).size === 0, error: null }
    } catch (error) {
        return {
            cleaned: false,
            error: new Error(`process inventory unavailable; detached descendant cleanup is unconfirmed: ${error instanceof Error ? error.message : String(error)}`),
        }
    }
}

function validateReport(reportPath, filtered, complete, root) {
    let report
    try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'))
    } catch (error) {
        throw new Error(`Vitest result report is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Number.isSafeInteger(report.numTotalTests) || report.numTotalTests < 1) throw new Error('Vitest did not report an executed test inventory')
    if (report.numTodoTests !== 0) throw new Error(`Vitest reported ${report.numTodoTests} todo tests`)
    if (filtered) return
    const skipped = report.testResults.flatMap(result => result.assertionResults)
        .filter(assertion => ['pending', 'skipped', 'todo'].includes(assertion.status))
        .map(assertion => assertion.fullName)
    const expected = expectedSkips(root)
    const unexpected = skipped.filter(name => !expected.some(([pattern]) => pattern.test(name)))
    if (unexpected.length > 0) throw new Error(`Vitest reported unexpected skipped tests: ${unexpected.join(', ')}`)
    if (report.numPendingTests !== skipped.length) throw new Error('Vitest pending count differs from the reported skipped inventory')
    if (complete) for (const [pattern, expectedCount] of expected) {
        const actual = skipped.filter(name => pattern.test(name)).length
        if (actual !== expectedCount) throw new Error(`Vitest expected skip inventory mismatch: expected ${expectedCount}, reported ${actual}`)
    }
    if (report.numPassedTests + report.numFailedTests + report.numPendingTests !== report.numTotalTests) {
        throw new Error('Vitest result counts do not cover the complete discovered inventory')
    }
}

// The reporter appends one line per finished test file, so this holds under a deadline kill too.
// A line that cannot be parsed fails the listing loudly rather than being skipped.
function unfinishedFiles(root, selected, progressPath) {
    const files = [...new Set(selected)].filter(path => existsSync(resolve(root, path)) && lstatSync(resolve(root, path)).isFile())
    if (!existsSync(progressPath)) return files
    const passed = new Set(readFileSync(progressPath, 'utf8').split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).filter(entry => entry.state === 'passed').map(entry => entry.file))
    return files.filter(path => !passed.has(resolve(root, path)))
}

// A deadline is usually spent by a few long files rather than by the queue behind them, so name
// the files that were still running, longest first, with how long each had been running.
function reportRunningAtDeadline(root, progressPath, now) {
    if (!existsSync(progressPath)) return
    const started = new Map()
    for (const entry of readFileSync(progressPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))) {
        if (entry.state === 'started') started.set(entry.file, entry.at)
        else started.delete(entry.file)
    }
    if (started.size === 0) return
    console.error('Still running at the deadline, longest first:')
    for (const [file, at] of [...started].sort((left, right) => left[1] - right[1])) {
        console.error(`  ${relative(root, file)} (${Math.round((now - at) / 1000)}s)`)
    }
}

function writeRemaining(root, id, selected, progressPath) {
    const remaining = unfinishedFiles(root, selected, progressPath)
    if (remaining.length === 0) return
    const relativePath = `.vitest-reports/remaining-${id}.txt`
    writeFileSync(resolve(root, relativePath), `${remaining.join('\n')}\n`)
    console.error(`${remaining.length} selected file${remaining.length === 1 ? '' : 's'} did not finish with a pass (failed or never ran before the deadline). Rerun exactly those:`)
    console.error(`npm test -- $(cat ${relativePath})`)
}

/**
 * @param {string[]} argv
 * @param {{root?: string, runner?: string, timeoutMs?: number, terminationGraceMs?: number, cleanupTimeoutMs?: number, processInventory?: typeof readProcessTable}} [options]
 * @returns {Promise<number>}
 */
export async function runTestsCli(argv, options = {}) {
    const root = realpathSync(options.root ?? process.cwd())
    const reportDirectory = resolve(root, '.vitest-reports')
    const runId = `${process.pid}-${Date.now()}`
    const reportPath = resolve(reportDirectory, `results-${runId}.json`)
    const progressPath = resolve(reportDirectory, `progress-${runId}.jsonl`)
    const latestReportPath = resolve(reportDirectory, 'latest.json')
    let selectedFiles = []
    let child
    let forwardedSignal = null
    let timedOut = false
    let terminationPromise = null
    const tracked = new Map()
    let observationInterval
    let observationFailure = null
    let rootIdentity = null
    let processInventory = readProcessTable
    let cleanupTimeoutMs = CLEANUP_TIMEOUT_MS
    let beginTermination
    let terminateAndSettle
    let invocationTemp
    let descendantsConfirmed = false
    let tempCleanupAttempted = false
    let tempCleanupComplete = false
    const signalHandlers = new Map()
    try {
        const parsed = parseArguments(argv)
        selectedFiles = parsed.positional
        const executionTimeoutMs = parsed.complete ? COMPLETE_EXECUTION_TIMEOUT_MS : TARGETED_EXECUTION_TIMEOUT_MS
        const timeoutMs = boundedDuration(options.timeoutMs, executionTimeoutMs, executionTimeoutMs, 'execution timeout')
        const terminationGraceMs = boundedDuration(options.terminationGraceMs, TERMINATION_GRACE_MS,
            TERMINATION_GRACE_MS, 'termination grace')
        cleanupTimeoutMs = boundedDuration(options.cleanupTimeoutMs, CLEANUP_TIMEOUT_MS,
            CLEANUP_TIMEOUT_MS, 'cleanup timeout')
        processInventory = options.processInventory ?? readProcessTable
        const terminationDeadlineMs = terminationGraceMs + cleanupTimeoutMs
            + Math.min(5_000, Math.max(500, terminationGraceMs + cleanupTimeoutMs))
        mkdirSync(reportDirectory, { recursive: true })
        const runner = options.runner ?? installedRunner(root)
        const arguments_ = [runner, 'run', ...parsed.arguments_, `--maxWorkers=${parsed.maxWorkers}`, '--allowOnly=false',
            '--reporter=default', `--reporter=${IMMEDIATE_FAILURE_REPORTER}`, '--reporter=json',
            `--outputFile.json=${reportPath}`]
        invocationTemp = createInvocationTemp()
        const outcome = await new Promise((resolveOutcome, rejectOutcome) => {
            let settled = false
            let executionTimeout
            const settle = value => {
                if (settled) return
                settled = true
                clearTimeout(executionTimeout)
                resolveOutcome(value)
            }
            for (const signal of ['SIGINT', 'SIGTERM']) {
                const handler = () => {
                    forwardedSignal ??= signal
                    terminateAndSettle?.(forwardedSignal)
                }
                signalHandlers.set(signal, handler)
                process.on(signal, handler)
            }
            child = spawn(process.execPath, ['--input-type=module', '-e', TEST_SUPERVISOR_PROGRAM, ...arguments_], {
                cwd: root,
                env: { ...process.env, COCKPIT_TEST_PROGRESS_FILE: progressPath, TMPDIR: invocationTemp.path, TMP: invocationTemp.path, TEMP: invocationTemp.path },
                detached: true,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            })
            if (!child.pid) {
                rejectOutcome(new Error('Vitest process did not receive a process id'))
                return
            }
            observeDescendants(child.pid, tracked, processInventory)
            rootIdentity = tracked.get(child.pid)
            if (!rootIdentity) {
                rejectOutcome(new Error('Vitest process identity was not observed'))
                return
            }
            beginTermination = (initialSignal = 'SIGTERM') => {
                terminationPromise ??= stopTree(child.pid, tracked, terminationGraceMs, cleanupTimeoutMs,
                    processInventory, initialSignal)
                    .then(cleaned => ({ cleaned, error: null }), error => ({ cleaned: false, error }))
                return terminationPromise
            }
            terminateAndSettle = initialSignal => {
                void withinCleanupDeadline(beginTermination(initialSignal), terminationDeadlineMs)
                    .then(termination => settle({ status: null, signal: null, termination }))
            }
            observationInterval = setInterval(() => {
                try {
                    observeDescendants(child.pid, tracked, processInventory)
                } catch (error) {
                    observationFailure ??= error
                    clearInterval(observationInterval)
                    terminateAndSettle('SIGTERM')
                }
            }, OBSERVATION_INTERVAL_MS)
            observationInterval.unref()
            executionTimeout = setTimeout(() => {
                timedOut = true
                terminateAndSettle('SIGTERM')
            }, timeoutMs)
            child.once('error', error => {
                clearTimeout(executionTimeout)
                rejectOutcome(error)
            })
            child.on('message', message => {
                if (message?.type === 'error') {
                    clearTimeout(executionTimeout)
                    rejectOutcome(new Error(`Vitest process failed to start: ${message.message}`))
                } else if (message?.type === 'outcome') {
                    settle({ status: message.status, signal: message.signal, termination: null })
                }
            })
            child.once('close', (status, signal) => {
                settle({ status, signal, termination: null })
            })
        })
        if (observationInterval) clearInterval(observationInterval)
        const cleanup = beginTermination?.()
            ?? stopTree(child.pid, tracked, terminationGraceMs, cleanupTimeoutMs, processInventory, 'SIGTERM')
                .then(cleaned => ({ cleaned, error: null }), error => ({ cleaned: false, error }))
        const termination = outcome.termination ?? await withinCleanupDeadline(cleanup, terminationDeadlineMs)
        if (termination.error) {
            throw new Error(`Vitest descendant cleanup failed: ${termination.error instanceof Error ? termination.error.message : String(termination.error)}`)
        }
        if (!termination.cleaned) throw new Error('Vitest descendant cleanup is incomplete')
        descendantsConfirmed = true
        tempCleanupAttempted = true
        const tempCleanup = cleanupInvocationTemp(invocationTemp)
        tempCleanupComplete = tempCleanup.cleaned
        if (!tempCleanup.cleaned) throw new Error(`test temporary directory cleanup incomplete: ${tempCleanup.reason}`)
        if (observationFailure) throw new Error(`process observation failed: ${observationFailure instanceof Error ? observationFailure.message : String(observationFailure)}`)
        if (timedOut) throw new Error(parsed.complete
            ? 'complete test run exceeded its 60 minute execution deadline'
            : 'selected test run exceeded its 13 minute 45 second execution deadline')
        if (forwardedSignal) return SIGNAL_STATUS[forwardedSignal]
        if (outcome.signal) throw new Error(`Vitest was interrupted by ${outcome.signal}`)
        if (!Number.isInteger(outcome.status)) throw new Error('Vitest did not report an exit status')
        if (outcome.status !== 0) return outcome.status
        validateReport(reportPath, parsed.filtered, parsed.complete, root)
        return 0
    } catch (error) {
        console.error(`TEST_RUN_INVALID: ${error instanceof Error ? error.message : String(error)}`)
        let fallbackConfirmed = descendantsConfirmed || !child?.pid
        if (child?.pid && !descendantsConfirmed) try {
            const fallback = await killOwnedTree(child, rootIdentity, tracked, cleanupTimeoutMs, processInventory)
            fallbackConfirmed = fallback.cleaned && !fallback.error
            if (fallback.error) console.error(`TEST_RUN_CLEANUP_FAILED: ${fallback.error.message}`)
            if (!fallback.cleaned) {
                console.error('TEST_RUN_CLEANUP_INCOMPLETE: test descendant cleanup is unconfirmed')
            }
        } catch (cleanupError) {
            console.error(`TEST_RUN_CLEANUP_FAILED: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
        }
        descendantsConfirmed ||= fallbackConfirmed
        if (invocationTemp && descendantsConfirmed && !tempCleanupAttempted) {
            tempCleanupAttempted = true
            const tempCleanup = cleanupInvocationTemp(invocationTemp)
            tempCleanupComplete = tempCleanup.cleaned
            if (!tempCleanup.cleaned) console.error(`TEST_RUN_TEMP_CLEANUP_FAILED: ${tempCleanup.reason}`)
        }
        if (invocationTemp && !descendantsConfirmed) {
            console.error(`TEST_RUN_TEMP_PRESERVED: ${invocationTemp.path}`)
        } else if (invocationTemp && !tempCleanupComplete) {
            console.error(`TEST_RUN_TEMP_CLEANUP_INCOMPLETE: remaining artifacts at ${invocationTemp.path}`)
        }
        return 2
    } finally {
        if (observationInterval) clearInterval(observationInterval)
        for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
        if (timedOut) try {
            reportRunningAtDeadline(root, progressPath, Date.now())
        } catch (error) {
            console.error(`TEST_RUN_RUNNING_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (selectedFiles.length > 0) try {
            writeRemaining(root, runId, selectedFiles, progressPath)
        } catch (error) {
            console.error(`TEST_RUN_REMAINING_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`)
        }
        rmSync(progressPath, { force: true })
        if (existsSync(reportPath)) renameSync(reportPath, latestReportPath)
        else rmSync(reportPath, { force: true })
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    process.exitCode = await runTestsCli(process.argv.slice(2))
}
