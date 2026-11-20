import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../cli.js'
import { installedPackageMetadata } from '../package-metadata.js'
import { CockpitConfig } from '../schema.js'
import { guardProveDoctorDiagnostics } from './application/guard-prove.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function captureIo() {
    let stdout = ''
    let stderr = ''
    const io: CliIo = {
        stdout: { write: (text) => ((stdout += text), true) },
        stderr: { write: (text) => ((stderr += text), true) },
    }
    return { io, output: () => ({ stdout, stderr }) }
}

function cockpit(cases = 'guard-cases.json') {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-guard-prove-cases-')))
    roots.push(root)
    mkdirSync(join(root, 'docs'))
    const configPath = join(root, 'cockpit.toml')
    writeFileSync(configPath, [
        '[cockpit]', 'name = "handbook"', 'siblings_root = "."', '',
        '[[sibling]]', 'slug = "docs"', 'dir = "docs"', 'mount = "always"', 'acquire = "none"', 'var = "DOCS_DIR"', 'purpose = "Notes"', '',
        '[ports]', 'bases = {}', '', '[guards]', `cases = ${JSON.stringify(cases)}`, '',
    ].join('\n'))
    const prove = async (args: readonly string[] = []) => {
        const capture = captureIo()
        const status = await runCli(['guard', 'prove', '--config', configPath, '--json', ...args], capture.io, {}, { env: { PATH: process.env.PATH } })
        return { status, response: JSON.parse(capture.output().stdout) }
    }
    return { root, prove }
}

describe('guard prove case files', () => {
    it('refuses a case file it cannot read as cases, naming what is wrong, before any hook runs', async () => {
        const { root, prove } = cockpit()

        // The declared file is missing, so the refusal names it.
        expect(await prove()).toMatchObject({ status: 2, response: { result: null,
            diagnostics: [{ code: 'GUARD_PROVE_CASES_INVALID', message: expect.stringContaining(join(root, 'guard-cases.json')) }] } })
        for (const [cases, wrong] of [
            [{ id: 'a', command: 'ls' }, /list/],
            // A misspelled key would otherwise drop the expectation and prove nothing.
            [[{ id: 'a', command: 'ls', expected: 'allow' }], /expected/],
            [[{ id: 'a', command: 'ls', expect: 'deny' }], /expect/],
            [[{ id: 'a', command: 'ls' }, { id: 'a', command: 'pwd' }], /entry 1\.id: an earlier entry has the same id/],
            [[{ id: 'a', command: '' }], /command/],
        ] as const) {
            writeFileSync(join(root, 'guard-cases.json'), JSON.stringify(cases))
            expect(await prove(), JSON.stringify(cases)).toMatchObject({ status: 2, response: { result: null,
                diagnostics: [{ code: 'GUARD_PROVE_CASES_INVALID', message: expect.stringMatching(wrong) }] } })
        }
        // --cases replaces the declared file for one run.
        writeFileSync(join(root, 'other.json'), 'not json')
        expect(await prove(['--cases', join(root, 'other.json')])).toMatchObject({ status: 2, response: {
            diagnostics: [{ code: 'GUARD_PROVE_CASES_INVALID', message: expect.stringContaining(join(root, 'other.json')) }] } })
    })

    // [guards] cases widens nothing, so an agent may set it unapproved: it must not read a secret back.
    it('reads a case file only inside the cockpit and outside what the guard protects, and never quotes its bytes', async () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-guard-prove-outside-')))
        roots.push(outside)
        writeFileSync(join(outside, 'token.json'), '[]')
        for (const [declared, wrong] of [
            [join(outside, 'token.json'), /outside the cockpit/],
            ['../token.json', /outside the cockpit/],
            ['secret', /not a \.json file/],
            ['.env.json', /keeps secret/],
            ['.cockpit/local/guard-identity.json', /guard protects/],
        ] as const) {
            const { prove } = cockpit(declared)
            expect(await prove(), declared).toMatchObject({ status: 2, response: { diagnostics: [{ code: 'GUARD_PROVE_CASES_INVALID', message: expect.stringMatching(wrong) }] } })
        }
        const { root, prove } = cockpit()
        // --cases is held to the same bounds.
        expect(await prove(['--cases', join(outside, 'token.json')])).toMatchObject({ status: 2, response: {
            diagnostics: [{ code: 'GUARD_PROVE_CASES_INVALID', message: expect.stringMatching(/outside the cockpit/) }] } })
        for (const bytes of ['SECRETVALUE-not-json', JSON.stringify([{ id: 'SECRETVALUE', command: 'ls' }, { id: 'SECRETVALUE', command: 'pwd' }])]) {
            writeFileSync(join(root, 'guard-cases.json'), bytes)
            const refused = await prove()
            expect(refused.status).toBe(2)
            expect(JSON.stringify(refused.response)).not.toContain('SECRETVALUE')
        }
    })
})

describe('guard prove in doctor', () => {
    it('warns until the installed version has a passing report it can read, failing closed on anything else', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-guard-prove-doctor-')))
        roots.push(root)
        const config = CockpitConfig.parse({ cockpit: { name: 'handbook' }, ports: { bases: {} },
            sibling: [{ slug: 'docs', dir: 'docs', mount: 'always', acquire: 'none', var: 'DOCS_DIR', purpose: 'Notes' }], guards: { cases: 'guard-cases.json' } })
        const codes = async () => (await guardProveDoctorDiagnostics(root, config)).map(row => row.code)
        expect(await codes()).toEqual(['GUARD_PROVE_REPORT_MISSING'])
        const directory = join(root, '.cockpit', 'local', 'guard-prove')
        mkdirSync(directory, { recursive: true })
        const report = { format: 'cockpit-guard-prove/v1', cockpitVersion: installedPackageMetadata.version, provedAt: '2026-01-01T00:00:00.000Z',
            status: 'passed', errors: [], results: [] }
        for (const [written, expected] of [
            [report, []],
            // A run that could not prove a harness leaves no failing row, only its status.
            [{ ...report, status: 'failed', errors: [{ code: 'GUARD_PROVE_HOOK_UNAVAILABLE', message: 'no hook' }] }, ['GUARD_PROVE_REPORT_FAILING']],
            [{}, ['GUARD_PROVE_REPORT_FAILING']],
            [{ ...report, format: 'other' }, ['GUARD_PROVE_REPORT_FAILING']],
            [{ ...report, cockpitVersion: '0.0.1' }, ['GUARD_PROVE_REPORT_FAILING']],
            [{ ...report, results: undefined }, ['GUARD_PROVE_REPORT_FAILING']],
            [{ ...report, results: [null] }, ['GUARD_PROVE_REPORT_FAILING']],
            ['not json', ['GUARD_PROVE_REPORT_FAILING']],
        ] as const) {
            writeFileSync(join(directory, `${installedPackageMetadata.version}.json`), typeof written === 'string' ? written : JSON.stringify(written))
            expect(await codes(), JSON.stringify(written)).toEqual(expected)
        }
    })
})
