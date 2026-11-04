import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadCockpitConfig } from '../config/load.js'
import { ANSWER_CONFIRMATION_PATH } from '../guards/answer-confirmation.js'
import { guardConfigChange } from '../guards/policy-change.js'
import { sha256Hex } from '../sha256.js'
import { runConfirm, type ConfirmCommandAdapters } from './application/confirm.js'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })

const HEAD = '# Unconfirmed: ports.bases was chosen by the setup agent as a default; no person stated it.\n'
const BODY = ['[cockpit]', 'name = "synthetic"', 'siblings_root = "."', '',
    '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"', 'purpose = "Synthetic app"', '',
    '[ports]', 'bases = { APP_PORT = 3000 }', '',
    '[environment]', 'compose_files = ["compose.yml"]',
    'machine = { runtime_memory_mb = 1024, runtime_cpus = 1, free_disk_mb = 1000, cold_start_seconds = 60 }', ''].join('\n')

function cockpit(unconfirmed: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-confirm-')))
    scratch.push(root)
    mkdirSync(join(root, '.cockpit'))
    const configPath = join(root, 'cockpit.toml')
    const text = `${HEAD}${unconfirmed}\n${BODY}`
    writeFileSync(configPath, text)
    return { root, configPath, text }
}

const row = (code: string, verdict: 'pass' | 'fail' | 'unavailable' | 'not-applicable') => ({ code, verdict, owner: 'synthetic', source: 'synthetic',
    stackId: `stack:${'1'.repeat(64)}`, reason: '', remedy: '', observedAt: '2026-11-04T00:00:00.000Z', expected: { kind: 'present' } }) as never
const FLOOR = ['MACHINE_MEMORY_BELOW_FLOOR', 'MACHINE_CPU_BELOW_FLOOR', 'MACHINE_DISK_BELOW_FLOOR', 'RUNTIME_UNMEASURED']

function adapters(preflight: Partial<{ status: number; codes: Readonly<Record<string, 'pass' | 'fail' | 'unavailable' | 'not-applicable'>> }> = {}, checkStatus = 0) {
    return {
        preflight: vi.fn(async () => ({ status: preflight.status ?? 0,
            diagnostics: preflight.status ? [{ severity: 'error' as const, code: 'STATE_UNSEEDED', message: 'no stack has been brought up' }] : [],
            result: { checks: Object.entries(preflight.codes ?? {}).map(([code, verdict]) => row(code, verdict)) } })),
        check: vi.fn(async () => ({ status: checkStatus,
            diagnostics: checkStatus ? [{ severity: 'error' as const, code: 'COMPOSE_TOPOLOGY_UNAVAILABLE', message: 'docker compose config failed' }] : [] })),
        now: () => new Date('2026-11-04T10:00:00.000Z'),
    } satisfies ConfirmCommandAdapters
}

describe('confirm', () => {
    it('refuses an answer only a person may confirm, naming the person and the command, before observing or writing anything', async () => {
        const { root, configPath, text } = cockpit('unconfirmed = ["guards", "cockpit.name"]')
        const observing = adapters()
        const guards = await runConfirm({ configPath, answer: 'guards' }, observing)
        expect(guards).toMatchObject({ status: 2, diagnostics: [{ severity: 'error', code: 'CONFIRM_PERSON_REQUIRED', target: 'guards',
            message: expect.stringContaining('it is a trust decision'),
            fix: `a person confirms guards with whoever owns the product, corrects cockpit.toml if a value is wrong, deletes its entry from unconfirmed, then runs npx --no cockpit sync --config ${configPath} in a terminal outside the agent` }] })
        // No observation settles a name, so it is a person's too, with the reason said.
        expect((await runConfirm({ configPath, answer: 'cockpit.name' }, observing)).diagnostics).toEqual([expect.objectContaining({
            code: 'CONFIRM_PERSON_REQUIRED', message: expect.stringContaining('no observation shows it is the one the owner wants') })])
        expect(observing.preflight).not.toHaveBeenCalled()
        expect(readFileSync(configPath, 'utf8')).toBe(text)
        expect(existsSync(join(root, ANSWER_CONFIRMATION_PATH))).toBe(false)
    })

    it('removes only the answer its observation verified, records that observation, and lets the guard admit the removal', async () => {
        const { root, configPath, text } = cockpit('unconfirmed = ["ports.bases", "environment.machine", "guards"]  # set by init')

        const ports = await runConfirm({ configPath, answer: 'ports.bases' }, adapters({ codes: { PORT_FAMILY_COLLISION: 'pass' } }))
        expect(ports).toMatchObject({ status: 0, diagnostics: [], result: { answer: 'ports.bases', observation: 'preflight', outcome: 'passed',
            ranAt: '2026-11-04T10:00:00.000Z', unconfirmed: ['environment.machine', 'guards'] } })
        // Only the list changed: the comments above it and beside it are kept.
        expect(readFileSync(configPath, 'utf8')).toBe(text.replace('["ports.bases", "environment.machine", "guards"]', '["environment.machine", "guards"]'))
        const record = JSON.parse(readFileSync(join(root, ANSWER_CONFIRMATION_PATH), 'utf8'))
        expect(record).toEqual({ format: 'cockpit-answer-confirmations/v1', confirmations: { 'ports.bases': { observation: 'preflight',
            ranAt: '2026-11-04T10:00:00.000Z', result: 'passed', evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            configurationSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } })

        // The stack is down, so preflight blocks, but the floor rows it observes without a stack pass.
        const machine = await runConfirm({ configPath, answer: 'environment.machine' },
            adapters({ status: 2, codes: Object.fromEntries(FLOOR.map(code => [code, 'pass'])) }))
        expect(machine).toMatchObject({ status: 0, result: { observation: 'runtime-floor', unconfirmed: ['guards'] } })
        expect(Object.keys(JSON.parse(readFileSync(join(root, ANSWER_CONFIRMATION_PATH), 'utf8')).confirmations)).toEqual(['ports.bases', 'environment.machine'])

        const current = await loadCockpitConfig(configPath)
        if (current.kind !== 'complete') throw new Error('the confirmed configuration does not load')
        const change = (confirmations: Uint8Array | undefined) => guardConfigChange(sha256Hex(text), Buffer.from(text),
            { sha256: current.result.source.sha256, config: current.result.config }, confirmations)
        expect(change(readFileSync(join(root, ANSWER_CONFIRMATION_PATH)))).toEqual({ kind: 'non-widening' })
        expect(change(undefined)).toEqual({ kind: 'widening', fields: ['unconfirmed'] })
    })

    it('drops the whole unconfirmed line once its last answer is confirmed', async () => {
        const { configPath, text } = cockpit('unconfirmed = ["environment.compose_files"]')
        const confirmed = await runConfirm({ configPath, answer: 'environment.compose_files' }, adapters())
        expect(confirmed).toMatchObject({ status: 0, result: { observation: 'check', unconfirmed: [] } })
        expect(readFileSync(configPath, 'utf8')).toBe(text.replace('unconfirmed = ["environment.compose_files"]\n', ''))
    })

    it('refuses by name, leaving cockpit.toml and the record alone, when the observation fails, cannot be recorded or has nothing to confirm', async () => {
        const { root, configPath, text } = cockpit('unconfirmed = ["ports.bases", "environment.machine", "environment.compose_files"]')
        const refused = async (answer: 'ports.bases' | 'environment.machine' | 'environment.compose_files', observing: ConfirmCommandAdapters) => {
            const outcome = await runConfirm({ configPath, answer }, observing)
            expect(readFileSync(configPath, 'utf8')).toBe(text)
            expect(existsSync(join(root, ANSWER_CONFIRMATION_PATH))).toBe(false)
            expect(outcome.status).toBe(2)
            return outcome.diagnostics
        }
        // A stack that is not up never confirms its ports, and the reason preflight gave is passed on.
        expect(await refused('ports.bases', adapters({ status: 2, codes: { PORT_FAMILY_COLLISION: 'not-applicable' } }))).toEqual([
            expect.objectContaining({ code: 'CONFIRM_OBSERVATION_FAILED', target: 'ports.bases', message: expect.stringContaining('preflight did not pass') }),
            expect.objectContaining({ code: 'STATE_UNSEEDED' })])
        expect(await refused('environment.machine', adapters({ codes: { ...Object.fromEntries(FLOOR.map(code => [code, 'pass'])), RUNTIME_UNMEASURED: 'unavailable' } })))
            .toEqual([expect.objectContaining({ code: 'CONFIRM_OBSERVATION_FAILED', message: expect.stringContaining('preflight did not observe RUNTIME_UNMEASURED passing') })])
        expect(await refused('environment.compose_files', adapters({}, 2))).toEqual([
            expect.objectContaining({ code: 'CONFIRM_OBSERVATION_FAILED', message: expect.stringContaining('check did not pass') }),
            expect.objectContaining({ code: 'COMPOSE_TOPOLOGY_UNAVAILABLE' })])

        // A record must bind to the configuration the observation read, so an edit made while it ran refuses.
        const swapped = adapters({ codes: { PORT_FAMILY_COLLISION: 'pass' } })
        const observed = swapped.preflight.getMockImplementation()!
        swapped.preflight.mockImplementation(async () => {
            writeFileSync(configPath, text.replace('APP_PORT = 3000', 'APP_PORT = 4000'))
            return observed()
        })
        const changed = await runConfirm({ configPath, answer: 'ports.bases' }, swapped)
        expect(changed.diagnostics).toEqual([expect.objectContaining({ code: 'CONFIG_CHANGED_DURING_EXECUTION' })])
        expect(existsSync(join(root, ANSWER_CONFIRMATION_PATH))).toBe(false)
        writeFileSync(configPath, text)

        // The record goes first, so an unwritable one leaves the entry in place.
        rmSync(join(root, '.cockpit'), { recursive: true })
        expect(await refused('ports.bases', adapters({ codes: { PORT_FAMILY_COLLISION: 'pass' } }))).toEqual([
            expect.objectContaining({ code: 'CONFIRM_RECORD_UNWRITABLE', target: ANSWER_CONFIRMATION_PATH })])

        const { configPath: other } = cockpit('unconfirmed = ["guards"]')
        expect((await runConfirm({ configPath: other, answer: 'ports.bases' }, adapters({ codes: { PORT_FAMILY_COLLISION: 'pass' } }))).diagnostics)
            .toEqual([expect.objectContaining({ code: 'CONFIRM_ANSWER_NOT_LISTED', target: 'unconfirmed' })])
    })
})
