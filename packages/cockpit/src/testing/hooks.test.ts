import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encodeOwnershipManifest } from '../surfaces/ownership.js'
import { planSurfaceChanges } from '../surfaces/sync.js'
import type { ExecutionStep } from '../environment/contract.js'
import { projectNativeHooks, checkNativeHookBudget, NATIVE_HOOK_COST_SCRIPT, type NativeHookEntry, type NativeHookInput } from './hooks.js'
import { resolveExecutablePath } from '../environment/executable.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const cockpitId = `cockpit:synthetic:${sha('identity')}`
const authority = { root: '/synthetic/cockpit', cockpitId, configPath: '/synthetic/cockpit/cockpit.toml' }
// The cost check measures wall-clock time of a real 128-process workload. A cap a loaded machine
// can reach turns the within-budget cases into load-dependent failures; the tight cap below is the
// deterministic control for the over-budget branch.
const policyLimitMs = 3_600_000
const policyBytes = `native-hook-ms=${policyLimitMs}\n`
const manifest = encodeOwnershipManifest({ ...authority, generation: sha('generation'), sourceSha256: sha('source'),
    owned: [{ path: 'hook-policy.txt', sha256: sha(policyBytes) }], surfaces: [] }).manifest
const policy = { manifest, authority, declarations: [], path: 'hook-policy.txt', exists: true, bytes: policyBytes }
const measurementDirectories: string[] = []
const cleanupMeasurements = () => {
    for (const directory of measurementDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
}
afterEach(cleanupMeasurements)
afterAll(cleanupMeasurements)
const prepareMeasurement = async (entry: NativeHookEntry) => {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-hook-cost-'))
    measurementDirectories.push(directory)
    const path = join(directory, 'pre-push')
    writeFileSync(path, entry.bytes)
    chmodSync(path, 0o755)
    const git = join(directory, 'git')
    writeFileSync(git, '#!/bin/sh\nprintf "ancestry\\n" >> "$CALL_LOG"\n')
    chmodSync(git, 0o755)
    const shell = await resolveExecutablePath('/bin/sh')
    if (shell.state !== 'available') throw new Error('authenticated system shell unavailable')
    // The workload spawns the fake Git 128 times, which takes seconds on a loaded host. The bound
    // stays below the 60 s hook timeout so an overrun is still reported as this step's timeout.
    const step: ExecutionStep = { id: 'native-hook-cost', argv: [shell.value.canonicalPath, '-c', NATIVE_HOOK_COST_SCRIPT, 'native-hook-cost', path, 'a'.repeat(40), 'b'.repeat(40)], argv0: shell.value.canonicalPath, cwd: directory,
        env: { PATH: directory, CALL_LOG: join(directory, 'calls') }, timeoutMs: 50_000, stdoutLimitBytes: 4096, stderrLimitBytes: 1024,
        paths: [], ports: [], labels: {}, expected: [], filesystemChecks: [], compensation: [],
        consumedFiles: [{ path: shell.value.canonicalPath, sha256: shell.value.sha256, maxBytes: 16_777_216, argvIndexes: [0], executable: true, executionMode: shell.value.executionMode },
            { path, sha256: entry.sha256, maxBytes: Buffer.byteLength(entry.bytes), argvIndexes: [4], executable: false }] }
    return step
}
const input = () => ({ cockpitId, harnesses: ['codexcli'], install: 'explicit-native' as const,
    budget: { prepareMeasurement, policy } })
type CompleteNativeHookProjection = Extract<Awaited<ReturnType<typeof projectNativeHooks>>, { kind: 'complete' }>
let authenticProjection: CompleteNativeHookProjection

beforeAll(async () => {
    const result = await projectNativeHooks(input())
    if (result.kind !== 'complete') throw new Error(`hook projection refused: ${JSON.stringify(result)}`)
    for (const entry of result.entries) Object.freeze(entry)
    Object.freeze(result.entries)
    authenticProjection = Object.freeze(result)
})

describe('native irreversible guards', () => {
    it('projects native desired entries with writer identity and a checked named budget, requiring explicit install', async () => {
        const inspect: NativeHookInput = { cockpitId, harnesses: input().harnesses, install: 'inspect' }
        expect((await projectNativeHooks(inspect)).kind).toBe('not-installed')
        expect(await projectNativeHooks({ ...input(), budget: { policy, measuredMs: 1 } } as unknown as Parameters<typeof projectNativeHooks>[0])).toMatchObject({ kind: 'refusal' })
        const result = authenticProjection
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') throw new Error('hook projection refused')
        expect(result.activation).toEqual({ kind: 'explicit-native-install', hooksPath: '.githooks', mode: 0o755 })
        expect(result.cost).toMatchObject({ kind: 'within-budget', scope: 'supplied-execution-environment', limitMs: policyLimitMs, executionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
        expect(result.entries).toHaveLength(1)
        const entry = result.entries[0]!
        expect(entry).toMatchObject({ path: '.githooks/pre-push', writer: 'cockpit', kind: 'file', ownership: 'whole-file' })
        expect(entry.bytes).toContain(cockpitId)
        expect(entry.bytes).toContain(`cockpit:budget name=native-hook-ms limit-ms=${policyLimitMs}`)
        const measurement = await prepareMeasurement(entry)
        expect(await checkNativeHookBudget(entry, measurement, policy)).toMatchObject({ kind: 'within-budget' })
        expect(readFileSync(measurement.env.CALL_LOG!, 'utf8').trim().split('\n')).toEqual(Array(128).fill('ancestry'))
        expect(await checkNativeHookBudget(entry, measurement, policy)).toMatchObject({ kind: 'within-budget' })
        expect(readFileSync(measurement.env.CALL_LOG!, 'utf8').trim().split('\n')).toEqual(Array(256).fill('ancestry'))
        expect(await checkNativeHookBudget(entry, { ...measurement, argv: [measurement.argv[4]!] }, policy)).toMatchObject({ kind: 'refusal' })
        expect(await checkNativeHookBudget({ ...entry, bytes: entry.bytes + 'exit 0\n' }, measurement, policy)).toMatchObject({ kind: 'refusal' })
        for (const changed of [{ ...policy, exists: false }, { ...policy, path: 'arbitrary-existing.txt' }, { ...policy, bytes: 'native-hook-ms=2000\n' }]) {
            expect(await projectNativeHooks({ ...input(), budget: { prepareMeasurement, policy: changed } })).toMatchObject({ kind: 'refusal' })
        }
        const tightPolicyBytes = 'native-hook-ms=1\n'
        const tightPolicy = { ...policy, bytes: tightPolicyBytes,
            manifest: encodeOwnershipManifest({ ...authority, generation: sha('tight-generation'), sourceSha256: sha('source'),
                owned: [{ path: 'hook-policy.txt', sha256: sha(tightPolicyBytes) }], surfaces: [] }).manifest }
        expect(await projectNativeHooks({ ...input(), budget: { prepareMeasurement, policy: tightPolicy } })).toMatchObject({ kind: 'ci-required' })
    }, 90000)

    it('composes the existing surface planner to refuse a foreign hook even when its bytes match', async () => {
        const result = authenticProjection
        const entry = result.entries[0]!
        const base = { configuredHarnesses: input().harnesses, desired: result.entries, priorOwned: [],
            observed: [{ path: entry.path, kind: 'file', bytes: entry.bytes, sha256: entry.sha256, identity: 'foreign-file' }] }
        expect(planSurfaceChanges(base)).toMatchObject({ kind: 'refusal' })
        const { bytes: _bytes, ...prior } = entry
        expect(planSurfaceChanges({ ...base, priorOwned: [prior] })).toMatchObject({ kind: 'complete', actions: [] })
    })

    it('runs only bounded ancestry guards and refuses deletion, force updates, malformed input and failed checks', async () => {
        const result = authenticProjection
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-native-hook-'))
        const hook = join(directory, 'pre-push')
        const git = join(directory, 'git')
        const log = join(directory, 'calls')
        writeFileSync(hook, result.entries[0]!.bytes)
        writeFileSync(git, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nexit "$GIT_EXIT"\n')
        chmodSync(git, 0o755)
        const update = (local = 'a'.repeat(40), remote = 'b'.repeat(40)) => `refs/heads/topic ${local} refs/heads/topic ${remote}\n`
        const run = (stdin: string, gitExit = '0') => spawnSync('/bin/sh', [hook], { input: stdin, encoding: 'utf8',
            env: { PATH: directory, CALL_LOG: log, GIT_EXIT: gitExit } })
        try {
            expect(run(update()).status).toBe(0)
            expect(readFileSync(log, 'utf8')).toBe(`merge-base --is-ancestor ${'b'.repeat(40)} ${'a'.repeat(40)}\n`)
            expect(run(update(), '1').stderr).toContain('non-fast-forward')
            expect(run(update(), '2').stderr).toContain('ancestry check failed')
            expect(run(update('0'.repeat(40))).stderr).toContain('deletion')
            expect(run('invalid\n').status).toBe(2)
            expect(run(update('a'.repeat(40), '0'.repeat(40))).status).toBe(0)
            expect(run(update().repeat(129)).stderr).toContain('128')
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })
})
