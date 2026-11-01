import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../../../../scripts/run-tests.mjs', import.meta.url))
const IMMEDIATE_FAILURE_REPORTER = fileURLToPath(new URL('../../../../scripts/immediate-failure-reporter.mjs', import.meta.url))
// The fake runners and their children ignore SIGTERM, so an interrupted run, when nothing is left to SIGKILL them, has
// left them running for days. Their keep-alive also exits once this test worker is gone.
const KEEP_ALIVE = `setInterval(() => { try { process.kill(${process.pid}, 0) } catch { process.exit(0) } }, 1000)`
const roots: string[] = []
const originalScenario = process.env.COCKPIT_RUNNER_SCENARIO
const originalPidPath = process.env.COCKPIT_RUNNER_PID_PATH
const originalTempPath = process.env.COCKPIT_RUNNER_TEMP_PATH
const originalGatePath = process.env.COCKPIT_RUNNER_GATE_PATH
const originalForkPidPath = process.env.COCKPIT_RUNNER_FORK_PID_PATH
const originalLateChildPath = process.env.COCKPIT_RUNNER_LATE_CHILD_PATH

afterEach(() => {
    if (originalScenario === undefined) delete process.env.COCKPIT_RUNNER_SCENARIO
    else process.env.COCKPIT_RUNNER_SCENARIO = originalScenario
    if (originalPidPath === undefined) delete process.env.COCKPIT_RUNNER_PID_PATH
    else process.env.COCKPIT_RUNNER_PID_PATH = originalPidPath
    if (originalTempPath === undefined) delete process.env.COCKPIT_RUNNER_TEMP_PATH
    else process.env.COCKPIT_RUNNER_TEMP_PATH = originalTempPath
    if (originalGatePath === undefined) delete process.env.COCKPIT_RUNNER_GATE_PATH
    else process.env.COCKPIT_RUNNER_GATE_PATH = originalGatePath
    if (originalForkPidPath === undefined) delete process.env.COCKPIT_RUNNER_FORK_PID_PATH
    else process.env.COCKPIT_RUNNER_FORK_PID_PATH = originalForkPidPath
    if (originalLateChildPath === undefined) delete process.env.COCKPIT_RUNNER_LATE_CHILD_PATH
    else process.env.COCKPIT_RUNNER_LATE_CHILD_PATH = originalLateChildPath
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-bounded-tests-'))
    roots.push(root)
    const runner = join(root, 'node_modules/vitest/vitest.mjs')
    mkdirSync(join(root, 'node_modules/vitest'), { recursive: true })
    mkdirSync(join(root, 'internal'))
    writeFileSync(runner, `
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const scenario = process.env.COCKPIT_RUNNER_SCENARIO
// Published by rename: the test polls for this path, and a file seen between creation and write reads as pid 0.
const publish = (path, value) => { writeFileSync(path + '.pending', value); renameSync(path + '.pending', path) }
const report = process.argv.find(argument => argument.startsWith('--outputFile.json='))?.split('=', 2)[1]
let invocationTemp
if (process.env.COCKPIT_RUNNER_TEMP_PATH) {
  if (!process.env.TMPDIR || process.env.TMP !== process.env.TMPDIR || process.env.TEMP !== process.env.TMPDIR) {
    throw new Error('test temporary environment is inconsistent')
  }
  const fixture = mkdtempSync(join(process.env.TMPDIR, 'synthetic-fixture-'))
  mkdirSync(join(fixture, 'created-directory'))
  writeFileSync(join(fixture, 'retained-on-interrupt.txt'), 'synthetic fixture\\n')
  invocationTemp = { root: process.env.TMPDIR, fixture }
  writeFileSync(process.env.COCKPIT_RUNNER_TEMP_PATH, JSON.stringify(invocationTemp))
}
const platformSkips = process.platform === 'linux' ? [
  'refuses ownership aliases of authenticated inputs on case-insensitive filesystems',
  'refuses ownership alias checks during a restored input namespace swap',
  'refuses ownership alias checks during a restored root namespace swap',
] : []
const assertions = [
  { status: 'passed', fullName: 'synthetic passes' },
  ...platformSkips.map(fullName => ({ status: 'skipped', fullName })),
]
const result = { numTotalTests: assertions.length, numPassedTests: 1, numFailedTests: 0,
  numPendingTests: platformSkips.length, numTodoTests: 0, testResults: [{ assertionResults: assertions }],
  arguments: process.argv.slice(2), childUmask: process.umask().toString(8),
  fixtureMode: invocationTemp ? statSync(join(invocationTemp.fixture, 'created-directory')).mode & 0o777 : null,
  fileMode: invocationTemp ? statSync(join(invocationTemp.fixture, 'retained-on-interrupt.txt')).mode & 0o777 : null,
  invocationMode: invocationTemp ? statSync(invocationTemp.root).mode & 0o777 : null }
if (scenario === 'nonzero') process.exit(7)
const finished = (name, state) => appendFileSync(process.env.COCKPIT_TEST_PROGRESS_FILE,
  JSON.stringify({ file: join(process.cwd(), name), state }) + '\\n')
if (scenario === 'partial-failure') {
  finished('a.test.ts', 'passed')
  finished('b.test.ts', 'failed')
  process.exit(1)
}
if (scenario === 'hang') finished('a.test.ts', 'passed')
if (scenario === 'unexpected-skip') {
  result.numPassedTests = 0
  result.numPendingTests += 1
  result.testResults[0].assertionResults[0] = { status: 'skipped', fullName: 'synthetic hidden skip' }
}
if (scenario === 'missing-internal') {
  result.numPassedTests = 0
  result.numPendingTests += 1
  result.testResults[0].assertionResults[0] = { status: 'skipped', fullName: 'configures the site-specific list, having the material for it' }
}
if (scenario === 'mismatched-pending') result.numPendingTests = 1
if (scenario === 'hang') {
  process.on('SIGTERM', () => {})
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});${KEEP_ALIVE}'], { detached: true, stdio: 'ignore' })
  child.unref()
  publish(process.env.COCKPIT_RUNNER_PID_PATH, String(child.pid))
  ${KEEP_ALIVE}
} else if (scenario === 'late-descendant') {
  const gate = process.env.COCKPIT_RUNNER_GATE_PATH
  const wait = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(gate)) Atomics.wait(wait, 0, 0, 10)
  const child = spawn(process.execPath, [process.env.COCKPIT_RUNNER_LATE_CHILD_PATH], { stdio: 'ignore' })
  child.unref()
  while (!existsSync(process.env.COCKPIT_RUNNER_PID_PATH)) Atomics.wait(wait, 0, 0, 10)
  writeFileSync(report, JSON.stringify(result))
  process.exit(0)
} else if (scenario === 'signal') {
  process.on('SIGTERM', () => {})
  process.on('SIGINT', () => {
    publish(process.env.COCKPIT_RUNNER_PID_PATH, 'SIGINT:' + process.pid)
    process.exit(0)
  })
  publish(process.env.COCKPIT_RUNNER_PID_PATH, String(process.pid))
  ${KEEP_ALIVE}
} else {
  if (scenario === 'replace-temp') {
    const moved = invocationTemp.root + '-moved'
    renameSync(invocationTemp.root, moved)
    mkdirSync(invocationTemp.root)
    writeFileSync(join(invocationTemp.root, 'foreign-replacement.txt'), 'preserve me\\n')
    invocationTemp = { ...invocationTemp, moved }
    writeFileSync(process.env.COCKPIT_RUNNER_TEMP_PATH, JSON.stringify(invocationTemp))
  }
  writeFileSync(report, JSON.stringify(result))
}
`)
    const run = (args: string[] = []) => spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: root, encoding: 'utf8', env: process.env, timeout: 5_000,
    })
    return { root, runner, run }
}

function alive(pid: number) {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
    }
}

function closeOf(child: ReturnType<typeof spawn>) {
    return new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolveClose => {
        child.once('close', (status, signal) => resolveClose({ status, signal }))
    })
}

async function within<T>(promise: Promise<T>, timeoutMs: number, failure: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(failure)), timeoutMs) }),
        ])
    } finally {
        clearTimeout(timeout)
    }
}

async function waitForFile(path: string, child: ReturnType<typeof spawn>, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(path)) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`child exited before writing ${path}`)
        if (Date.now() >= deadline) throw new Error(`child did not write ${path} within ${timeoutMs}ms`)
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

function readPid(path: string): number {
    const raw = readFileSync(path, 'utf8')
    const pid = Number(raw)
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`${path} holds ${JSON.stringify(raw)}, not a process id`)
    return pid
}

async function cleanupOwned(child: ReturnType<typeof spawn>, closed: ReturnType<typeof closeOf>, ownedPid?: number) {
    if (ownedPid && alive(ownedPid)) process.kill(ownedPid, 'SIGKILL')
    for (let attempt = 0; ownedPid && attempt < 100 && alive(ownedPid); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (ownedPid && alive(ownedPid)) throw new Error(`owned process ${ownedPid} survived cleanup`)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await within(closed, 2_000, 'owned wrapper did not exit during cleanup')
}

type InvocationTemp = Readonly<{ root: string; fixture: string; moved?: string }>

function invocationTemp(path: string): InvocationTemp {
    return JSON.parse(readFileSync(path, 'utf8')) as InvocationTemp
}

function expectOwnedTempRemoved(record: InvocationTemp) {
    expect(record.root.startsWith(join(tmpdir(), 'cockpit-test-run-'))).toBe(true)
    expect(existsSync(record.root)).toBe(false)
    expect(existsSync(record.fixture)).toBe(false)
}

function cleanupRecordedTemp(record: InvocationTemp | undefined) {
    if (!record) return
    if (record.root.startsWith(join(tmpdir(), 'cockpit-test-run-'))) rmSync(record.root, { recursive: true, force: true })
    else rmSync(record.fixture, { recursive: true, force: true })
    if (record.moved?.startsWith(join(tmpdir(), 'cockpit-test-run-'))) rmSync(record.moved, { recursive: true, force: true })
}

describe('bounded test runner', () => {
    it('gives the test subprocess a safe consistent creation mask under a hostile inherited umask', () => {
        const { root, run } = fixture()
        const tempPath = join(root, 'private-umask-temp.json')
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath
        const previousUmask = process.umask(0o000)
        let result: ReturnType<typeof run>
        try {
            result = run()
        } finally {
            process.umask(previousUmask)
        }

        expect(result.status, result.stderr).toBe(0)
        const report = JSON.parse(readFileSync(join(root, '.vitest-reports/latest.json'), 'utf8'))
        expect(report.childUmask).toBe('22')
        expect(report.fixtureMode).toBe(0o755)
        expect(report.fileMode).toBe(0o644)
        expect(report.invocationMode).toBe(0o700)
    })

    it('caps worker options and owns reporter, selection, and completion options', async () => {
        const { root, run } = fixture()
        for (const args of [['--maxWorkers=1'], ['--maxWorkers', '2']] as const) {
            expect(run([...args]).status).toBe(0)
            const report = JSON.parse(readFileSync(join(root, '.vitest-reports/latest.json'), 'utf8'))
            expect(report.arguments.filter((argument: string) => argument.startsWith('--maxWorkers'))).toEqual([
                `--maxWorkers=${args.at(-1)?.replace('--maxWorkers=', '')}`,
            ])
            expect(report.arguments.filter((argument: string) => argument.startsWith('--reporter='))).toEqual([
                '--reporter=default',
                `--reporter=${IMMEDIATE_FAILURE_REPORTER}`,
                '--reporter=json',
            ])
        }
        for (const argument of ['--maxWorkers=0', '--maxWorkers=-1', '--maxWorkers=1.5', '--maxWorkers=5', '--reporter=json', '--shard=1/2', '--watch', '--passWithNoTests', '--allowOnly=true']) {
            expect(run([argument]).status).toBe(2)
        }
        expect(run(['--maxWorkers']).status).toBe(2)
        expect(run(['--maxWorkers=1', '--maxWorkers', '2']).status).toBe(2)
        process.env.COCKPIT_RUNNER_SCENARIO = 'unexpected-skip'
        expect(run(['--maxWorkers=2']).status).toBe(2)
    })

    it('prints every failed-case error synchronously and remains silent for passed cases', async () => {
        const { default: ImmediateFailureReporter } = await import(pathToFileURL(IMMEDIATE_FAILURE_REPORTER).href)
        const lines: string[] = []
        const printed: Array<readonly [unknown, unknown]> = []
        const logger = {
            error: (...values: unknown[]) => lines.push(values.join(' ')),
            printError: (error: unknown, options: unknown) => printed.push([error, options]),
        }
        const reporter = new ImmediateFailureReporter()
        reporter.onInit({ logger })
        const project = { name: 'synthetic project' }
        const common = {
            module: { relativeModuleId: 'synthetic.test.ts' },
            fullName: 'suite > case',
            project,
        }

        reporter.onTestCaseResult({ ...common, result: () => ({ state: 'passed' }) })
        expect(lines).toEqual([])
        expect(printed).toEqual([])

        const first = { name: 'Error', message: 'first failure', stack: 'Error: first failure\n    at synthetic.test.ts:1:1' }
        const second = { name: 'Error', message: 'second failure', stack: 'Error: second failure\n    at synthetic.test.ts:2:1' }
        reporter.onTestCaseResult({ ...common, result: () => ({ state: 'failed', errors: [first, second] }) })

        expect(lines).toEqual(['\n FAIL synthetic.test.ts > suite > case'])
        expect(printed).toEqual([
            [first, { project }],
            [second, { project }],
        ])
    })

    it('records each finished test module in the progress file named by the environment', async () => {
        const { default: ImmediateFailureReporter } = await import(pathToFileURL(IMMEDIATE_FAILURE_REPORTER).href)
        const { root } = fixture()
        const progress = join(root, 'progress.jsonl')
        const reporter = new ImmediateFailureReporter()
        const module = (moduleId: string, state: string, ok: boolean) => ({ moduleId, state: () => state, ok: () => ok })
        process.env.COCKPIT_TEST_PROGRESS_FILE = progress
        try {
            reporter.onTestModuleEnd(module('/synthetic/a.test.ts', 'passed', true))
            reporter.onTestModuleEnd(module('/synthetic/b.test.ts', 'failed', false))
            reporter.onTestModuleEnd(module('/synthetic/c.test.ts', 'skipped', true))
        } finally {
            delete process.env.COCKPIT_TEST_PROGRESS_FILE
        }
        expect(readFileSync(progress, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
            { file: '/synthetic/a.test.ts', state: 'passed' },
            { file: '/synthetic/b.test.ts', state: 'failed' },
            { file: '/synthetic/c.test.ts', state: 'failed' },
        ])
    })

    it('keeps selected runs within the targeted deadline and bounds the complete-suite deadline', async () => {
        const { root } = fixture()
        const run = (arguments_: readonly string[], options: Record<string, number>) => spawnSync(process.execPath, ['--input-type=module', '-e',
            `const { runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)}); process.exitCode = await runTestsCli(${JSON.stringify(arguments_)}, ${JSON.stringify({ root, ...options })})`],
        { cwd: root, encoding: 'utf8' })

        expect(run([], { timeoutMs: 825_001 }).status).toBe(0)
        expect(run([], { timeoutMs: 3_600_001 }).status).toBe(2)
        expect(run(['synthetic.test.ts'], { timeoutMs: 825_001 }).status).toBe(2)
        expect(run([], { terminationGraceMs: 10_001 }).status).toBe(2)
        expect(run([], { cleanupTimeoutMs: 5_001 }).status).toBe(2)
    })

    it('returns the test status and accepts a complete successful report', async () => {
        const { root, run } = fixture()
        const tempPath = join(root, 'invocation-temp.json')
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath
        const concurrentReport = join(root, '.vitest-reports/results-999-999.json')
        mkdirSync(join(root, '.vitest-reports'), { recursive: true })
        writeFileSync(concurrentReport, 'active concurrent report\n')
        const success = run()
        const successTemp = invocationTemp(tempPath)
        try {
            expect(success.status).toBe(0)
            expectOwnedTempRemoved(successTemp)
        } finally {
            cleanupRecordedTemp(successTemp)
        }
        expect(JSON.parse(readFileSync(join(root, '.vitest-reports/latest.json'), 'utf8')).numPassedTests).toBe(1)
        expect(readFileSync(concurrentReport, 'utf8')).toBe('active concurrent report\n')
        process.env.COCKPIT_RUNNER_SCENARIO = 'nonzero'
        const nonzero = run()
        const nonzeroTemp = invocationTemp(tempPath)
        try {
            expect(nonzero.status).toBe(7)
            expectOwnedTempRemoved(nonzeroTemp)
        } finally {
            cleanupRecordedTemp(nonzeroTemp)
        }
    })

    it('removes owned test temporary files after a confirmed execution timeout', async () => {
        const { root } = fixture()
        const pidPath = join(root, 'timeout-descendant.pid')
        const tempPath = join(root, 'timeout-temp.json')
        process.env.COCKPIT_RUNNER_SCENARIO = 'hang'
        process.env.COCKPIT_RUNNER_PID_PATH = pidPath
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath
        const code = `
const { runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})
process.exitCode = await runTestsCli([], {
  root: ${JSON.stringify(root)},
  timeoutMs: 1100,
  terminationGraceMs: 50,
  cleanupTimeoutMs: 500,
})
`

        const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', code], {
            // The wrapper also bounds process inventory and temporary cleanup at five seconds each.
            cwd: root, encoding: 'utf8', env: process.env, timeout: 20_000,
        })

        const descendant = readPid(pidPath)
        let temp: InvocationTemp | undefined
        try {
            temp = invocationTemp(tempPath)
            expect(result.error).toBeUndefined()
            expect(result.status, result.stderr).toBe(2)
            expect(result.stderr).toContain('complete test run exceeded its 60 minute execution deadline')
            expect(alive(descendant)).toBe(false)
            expectOwnedTempRemoved(temp)
        } finally {
            if (alive(descendant)) process.kill(descendant, 'SIGKILL')
            cleanupRecordedTemp(temp)
        }
    })

    it('records the selected files that did not complete and prints one command that reruns them', async () => {
        const { root, run } = fixture()
        const selected = ['a.test.ts', 'b.test.ts', 'c.test.ts']
        for (const name of selected) writeFileSync(join(root, name), 'synthetic\n')
        const remainingFiles = () => readdirSync(join(root, '.vitest-reports')).filter(name => name.startsWith('remaining-'))

        process.env.COCKPIT_RUNNER_SCENARIO = 'partial-failure'
        const partial = run(selected)
        expect(partial.status).toBe(1)
        const [partialFile] = remainingFiles()
        expect(readFileSync(join(root, '.vitest-reports', partialFile), 'utf8')).toBe('b.test.ts\nc.test.ts\n')
        expect(partial.stderr).toContain(`npm test -- $(cat .vitest-reports/${partialFile})`)

        // A run cut off by the deadline writes no JSON report; the progress record still excludes a.test.ts.
        rmSync(join(root, '.vitest-reports'), { recursive: true })
        process.env.COCKPIT_RUNNER_SCENARIO = 'hang'
        process.env.COCKPIT_RUNNER_PID_PATH = join(root, 'deadline-descendant.pid')
        const code = `
const { runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})
process.exitCode = await runTestsCli(${JSON.stringify(selected)}, {
  root: ${JSON.stringify(root)}, timeoutMs: 1100, terminationGraceMs: 50, cleanupTimeoutMs: 500,
})
`
        const deadline = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
            cwd: root, encoding: 'utf8', env: process.env, timeout: 20_000,
        })
        const descendant = readPid(process.env.COCKPIT_RUNNER_PID_PATH)
        try {
            expect(deadline.status, deadline.stderr).toBe(2)
            expect(deadline.stderr).toContain('selected test run exceeded its 13 minute 45 second execution deadline')
            const [deadlineFile] = remainingFiles()
            expect(readFileSync(join(root, '.vitest-reports', deadlineFile), 'utf8')).toBe('b.test.ts\nc.test.ts\n')
            expect(deadline.stderr).toContain(`npm test -- $(cat .vitest-reports/${deadlineFile})`)
        } finally {
            if (alive(descendant)) process.kill(descendant, 'SIGKILL')
        }
    })

    it('removes a same-group child spawned after the initial observation before deleting temporary files', async () => {
        const { root } = fixture()
        const gatePath = join(root, 'initial-observation-complete')
        const pidPath = join(root, 'late-descendant.pid')
        const forkPidPath = join(root, 'late-descendant-fork.pid')
        const tempPath = join(root, 'late-descendant-temp.json')
        const lateChildPath = join(root, 'late-descendant.cjs')
        writeFileSync(lateChildPath, [
            "const { spawn } = require('node:child_process')",
            "const { renameSync, writeFileSync } = require('node:fs')",
            "const publish = (path, value) => { writeFileSync(path + '.pending', value); renameSync(path + '.pending', path) }",
            "process.on('SIGTERM', () => {",
            "  const fork = spawn(process.execPath, ['-e', 'process.on(\\\"SIGTERM\\\",()=>{});" + KEEP_ALIVE + "'], { stdio: 'ignore' })",
            '  fork.unref()',
            '  publish(process.env.COCKPIT_RUNNER_FORK_PID_PATH, String(fork.pid))',
            '  process.exit(0)',
            '})',
            'publish(process.env.COCKPIT_RUNNER_PID_PATH, String(process.pid))',
            'setInterval(() => {}, 1000)',
            '',
        ].join('\n'))
        process.env.COCKPIT_RUNNER_SCENARIO = 'late-descendant'
        process.env.COCKPIT_RUNNER_GATE_PATH = gatePath
        process.env.COCKPIT_RUNNER_PID_PATH = pidPath
        process.env.COCKPIT_RUNNER_FORK_PID_PATH = forkPidPath
        process.env.COCKPIT_RUNNER_LATE_CHILD_PATH = lateChildPath
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath
        const code = `
import { writeFileSync } from 'node:fs'
const { readProcessTable, runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})
let inventories = 0
process.exitCode = await runTestsCli([], {
  root: ${JSON.stringify(root)},
  terminationGraceMs: 50,
  cleanupTimeoutMs: 500,
  processInventory: () => {
    const rows = readProcessTable()
    inventories += 1
    if (inventories === 1) writeFileSync(${JSON.stringify(gatePath)}, 'observed\\n')
    return rows
  },
})
`

        const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', code], {
            cwd: root, encoding: 'utf8', env: process.env, timeout: 20_000,
        })

        let descendant: number | undefined
        let temp: InvocationTemp | undefined
        let fork: number | undefined
        try {
            expect(result.error).toBeUndefined()
            expect(result.status, result.stderr).toBe(0)
            descendant = readPid(pidPath)
            temp = invocationTemp(tempPath)
            expect(alive(descendant)).toBe(false)
            fork = readPid(forkPidPath)
            expect(alive(fork)).toBe(false)
            expectOwnedTempRemoved(temp)
        } finally {
            if (descendant === undefined && existsSync(pidPath)) descendant = readPid(pidPath)
            if (fork === undefined && existsSync(forkPidPath)) fork = readPid(forkPidPath)
            if (temp === undefined && existsSync(tempPath)) temp = invocationTemp(tempPath)
            if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL')
            if (fork && alive(fork)) process.kill(fork, 'SIGKILL')
            for (let attempt = 0; descendant && attempt < 100 && alive(descendant); attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 10))
            }
            for (let attempt = 0; fork && attempt < 100 && alive(fork); attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 10))
            }
            cleanupRecordedTemp(temp)
        }
        expect(alive(descendant!)).toBe(false)
        expect(alive(fork!)).toBe(false)
    })

    it('preserves invocation temporary files when the authenticated supervisor disappears from observation', () => {
        const { root } = fixture()
        const tempPath = join(root, 'lost-supervisor-temp.json')
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath
        const code = `
const { readProcessTable, runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})
let supervisorPid
process.exitCode = await runTestsCli([], {
  root: ${JSON.stringify(root)},
  processInventory: () => {
    const rows = readProcessTable()
    if (supervisorPid === undefined) {
      const supervisors = [...rows.values()].filter(row => row.ppid === process.pid && row.pgid === row.pid)
      if (supervisors.length !== 1) throw new Error('synthetic supervisor identity was not unique')
      supervisorPid = supervisors[0].pid
      return rows
    }
    rows.delete(supervisorPid)
    return rows
  },
})
`

        const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', code], {
            cwd: root, encoding: 'utf8', env: process.env, timeout: 20_000,
        })

        let temp: InvocationTemp | undefined
        try {
            temp = invocationTemp(tempPath)
            expect(result.error).toBeUndefined()
            expect(result.status, result.stderr).toBe(2)
            expect(result.stderr).toContain('authenticated supervisor identity was lost')
            expect(result.stderr).toContain(`TEST_RUN_TEMP_PRESERVED: ${temp.root}`)
            expect(existsSync(temp.fixture)).toBe(true)
        } finally {
            cleanupRecordedTemp(temp)
        }
    })

    it('exits bounded when process inventory fails at the execution deadline', async () => {
        const { root } = fixture()
        const pidPath = join(root, 'inventory-failure-descendant.pid')
        const tempPath = join(root, 'inventory-failure-temp.json')
        process.env.COCKPIT_RUNNER_SCENARIO = 'hang'
        process.env.COCKPIT_RUNNER_PID_PATH = pidPath
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath
        const code = `
const { readProcessTable, runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})
let inventories = 0
const status = await runTestsCli([], {
  root: ${JSON.stringify(root)},
  timeoutMs: 1100,
  terminationGraceMs: 50,
  cleanupTimeoutMs: 50,
  processInventory: () => {
    inventories += 1
    if (inventories < 3) return readProcessTable()
    throw new Error('synthetic process inventory failure')
  },
})
process.exitCode = status
`

        const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', code], {
            cwd: root, encoding: 'utf8', env: process.env, timeout: 4_000,
        })

        const descendant = readPid(pidPath)
        const temp = invocationTemp(tempPath)
        try {
            expect(result.error).toBeUndefined()
            expect(result.status, result.stderr).toBe(2)
            expect(result.stderr).toContain('detached descendant cleanup is unconfirmed')
            expect(result.stderr).toContain(`TEST_RUN_TEMP_PRESERVED: ${temp.root}`)
            expect(alive(descendant)).toBe(true)
            expect(existsSync(temp.fixture)).toBe(true)
        } finally {
            if (alive(descendant)) process.kill(descendant, 'SIGKILL')
            for (let attempt = 0; attempt < 100 && alive(descendant); attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 10))
            }
            cleanupRecordedTemp(temp)
        }
        expect(alive(descendant)).toBe(false)
    })

    it('stops the run immediately when periodic process observation fails', async () => {
        const { root } = fixture()
        const pidPath = join(root, 'periodic-inventory-failure-descendant.pid')
        const tempPath = join(root, 'periodic-inventory-failure-temp.json')
        process.env.COCKPIT_RUNNER_SCENARIO = 'hang'
        process.env.COCKPIT_RUNNER_PID_PATH = pidPath
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath
        const code = `
import { existsSync, readFileSync } from 'node:fs'
const { readProcessTable, runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})
const wait = new Int32Array(new SharedArrayBuffer(4))
let inventories = 0
let observed
const status = await runTestsCli([], {
  root: ${JSON.stringify(root)},
  timeoutMs: 20_000,
  terminationGraceMs: 100,
  cleanupTimeoutMs: 100,
  processInventory: () => {
    inventories += 1
    if (inventories === 1) {
      while (!existsSync(${JSON.stringify(pidPath)})) Atomics.wait(wait, 0, 0, 10)
      observed = readProcessTable()
      const descendant = observed.get(Number(readFileSync(${JSON.stringify(pidPath)}, 'utf8')))
      if (!descendant) throw new Error('synthetic process identity was not observed')
      return observed
    }
    if (inventories === 2) throw new Error('synthetic periodic process inventory failure')
    return readProcessTable()
  },
})
process.exitCode = status
`

        const child = spawn(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', code], {
            cwd: root, env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
        })
        const closed = closeOf(child)
        const errors: Buffer[] = []
        child.stderr.on('data', chunk => errors.push(chunk))
        let descendant: number | undefined
        let temp: InvocationTemp | undefined
        try {
            await waitForFile(pidPath, child)
            descendant = readPid(pidPath)
            temp = invocationTemp(tempPath)
            const started = Date.now()
            const outcome = await within(closed, 8_000, 'runner did not stop after process observation failed')
            expect(outcome.status, Buffer.concat(errors).toString('utf8')).toBe(2)
            expect(outcome.signal).toBeNull()
            expect(Buffer.concat(errors).toString('utf8')).toContain('process observation failed: synthetic periodic process inventory failure')
            expect(Date.now() - started).toBeLessThan(8_000)
            expect(alive(descendant)).toBe(false)
            expectOwnedTempRemoved(temp)
        } finally {
            await cleanupOwned(child, closed, descendant)
            cleanupRecordedTemp(temp)
        }
        expect(alive(descendant!)).toBe(false)
    })

    it('does not claim detached cleanup when initial inventory omits the root', async () => {
        const { root } = fixture()
        const pidPath = join(root, 'omitted-root-descendant.pid')
        const tempPath = join(root, 'omitted-root-temp.json')
        process.env.COCKPIT_RUNNER_SCENARIO = 'hang'
        process.env.COCKPIT_RUNNER_PID_PATH = pidPath
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath
        const code = `
import { existsSync } from 'node:fs'
const { runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})
const wait = new Int32Array(new SharedArrayBuffer(4))
const status = await runTestsCli([], {
  root: ${JSON.stringify(root)},
  cleanupTimeoutMs: 50,
  processInventory: () => {
    while (!existsSync(${JSON.stringify(pidPath)})) Atomics.wait(wait, 0, 0, 10)
    return new Map()
  },
})
process.exitCode = status
`

        const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', code], {
            cwd: root, encoding: 'utf8', env: process.env, timeout: 20_000,
        })

        const descendant = readPid(pidPath)
        const temp = invocationTemp(tempPath)
        try {
            expect(result.error).toBeUndefined()
            expect(result.status, result.stderr).toBe(2)
            expect(result.stderr).toContain('root process identity was never observed; detached descendant cleanup is unconfirmed')
            expect(result.stderr).toContain(`TEST_RUN_TEMP_PRESERVED: ${temp.root}`)
            expect(alive(descendant)).toBe(true)
            expect(existsSync(temp.fixture)).toBe(true)
        } finally {
            if (alive(descendant)) process.kill(descendant, 'SIGKILL')
            for (let attempt = 0; attempt < 100 && alive(descendant); attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 10))
            }
            cleanupRecordedTemp(temp)
        }
        expect(alive(descendant)).toBe(false)
    })

    it('accepts a regular installed runner through a node_modules directory link', () => {
        const { root, run } = fixture()
        const dependencies = mkdtempSync(join(tmpdir(), 'cockpit-bounded-dependencies-'))
        roots.push(dependencies)
        renameSync(join(root, 'node_modules'), join(dependencies, 'node_modules'))
        symlinkSync(join(dependencies, 'node_modules'), join(root, 'node_modules'))

        expect(run().status).toBe(0)
    })

    it('preserves a foreign replacement of the owned temporary path', () => {
        const { root, run } = fixture()
        const tempPath = join(root, 'replacement-temp.json')
        process.env.COCKPIT_RUNNER_SCENARIO = 'replace-temp'
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath

        const result = run()
        const temp = invocationTemp(tempPath)
        try {
            expect(result.status, result.stderr).toBe(2)
            expect(result.stderr).toContain(`TEST_RUN_TEMP_CLEANUP_INCOMPLETE: remaining artifacts at ${temp.root}`)
            expect(readFileSync(join(temp.root, 'foreign-replacement.txt'), 'utf8')).toBe('preserve me\n')
            expect(existsSync(temp.moved!)).toBe(true)
        } finally {
            cleanupRecordedTemp(temp)
        }
    })

    it('rejects hidden skips and inconsistent pending counts while allowing explicit name filters', () => {
        const { root, run } = fixture()
        process.env.COCKPIT_RUNNER_SCENARIO = 'unexpected-skip'
        expect(run().status).toBe(2)
        expect(run(['-t', 'selected behavior']).status).toBe(0)
        process.env.COCKPIT_RUNNER_SCENARIO = 'mismatched-pending'
        expect(run().status).toBe(2)
        rmSync(join(root, 'internal'), { recursive: true })
        process.env.COCKPIT_RUNNER_SCENARIO = 'missing-internal'
        expect(run().status).toBe(0)
    })

    it('kills the complete descendant tree when the runner is terminated', async () => {
        const { root } = fixture()
        const pidPath = join(root, 'descendant.pid')
        const tempPath = join(root, 'termination-temp.json')
        process.env.COCKPIT_RUNNER_SCENARIO = 'hang'
        process.env.COCKPIT_RUNNER_PID_PATH = pidPath
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath

        const code = `
const { runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})
process.exitCode = await runTestsCli([], {
  root: ${JSON.stringify(root)},
  terminationGraceMs: 200,
  cleanupTimeoutMs: 200,
})
`
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
            cwd: root, env: process.env, stdio: 'ignore',
        })
        const closed = closeOf(child)
        let descendant: number | undefined
        let temp: InvocationTemp | undefined
        try {
            await waitForFile(pidPath, child)
            descendant = readPid(pidPath)
            temp = invocationTemp(tempPath)
            child.kill('SIGTERM')
            await new Promise(resolve => setTimeout(resolve, 20))
            child.kill('SIGTERM')
            const outcome = await within(closed, 5_000, 'runner did not exit after repeated termination')

            expect(outcome.status).toBe(143)
            expect(outcome.signal).toBeNull()
            expect(alive(descendant)).toBe(false)
            expectOwnedTempRemoved(temp)
        } finally {
            await cleanupOwned(child, closed, descendant)
            cleanupRecordedTemp(temp)
        }
    })

    it('forwards an interrupt to the process group and returns its conventional status', async () => {
        const { root } = fixture()
        process.env.COCKPIT_RUNNER_SCENARIO = 'signal'
        const pidPath = join(root, 'signal-ready')
        const tempPath = join(root, 'interrupt-temp.json')
        process.env.COCKPIT_RUNNER_PID_PATH = pidPath
        process.env.COCKPIT_RUNNER_TEMP_PATH = tempPath
        const code = `
const { readProcessTable, runTestsCli } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})
const wait = new Int32Array(new SharedArrayBuffer(4))
let inventories = 0
process.exitCode = await runTestsCli([], {
  root: ${JSON.stringify(root)},
  processInventory: () => {
    inventories += 1
    if (inventories === 1) Atomics.wait(wait, 0, 0, 500)
    return readProcessTable()
  },
})
`
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
            cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
        })
        const closed = closeOf(child)
        const errors: Buffer[] = []
        child.stderr.on('data', chunk => errors.push(chunk))
        let runnerPid: number | undefined
        let temp: InvocationTemp | undefined
        try {
            await waitForFile(pidPath, child)
            runnerPid = readPid(pidPath)
            temp = invocationTemp(tempPath)
            child.kill('SIGINT')
            const outcome = await within(closed, 5_000, 'runner did not exit after SIGINT')
            expect(outcome.status, Buffer.concat(errors).toString('utf8')).toBe(130)
            expect(outcome.signal).toBeNull()
            expect(readFileSync(pidPath, 'utf8')).toBe(`SIGINT:${runnerPid}`)
            expectOwnedTempRemoved(temp)
        } finally {
            await cleanupOwned(child, closed, runnerPid)
            cleanupRecordedTemp(temp)
        }
    })
})
