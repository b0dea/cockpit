import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { comparisonCommand } from './command.js'
import { parseComparisonFixture } from './contract.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixtureRoot() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-comparison-command-')))
    roots.push(root)
    const fixture = await readFile(new URL('../../../../fixtures/comparison/command-set.json', import.meta.url), 'utf8')
    await writeFile(join(root, 'comparison.json'), fixture)
    return root
}

describe('comparison command', () => {
    it('validates the actual bounded fixture without creating evidence or authorizing an operator gate', async () => {
        const root = await fixtureRoot()
        const result = await comparisonCommand({ root, operation: 'validate', fixturePath: 'comparison.json' })
        expect(result).toMatchObject({ kind: 'complete', status: 0, diagnostics: [],
            result: { fixtureId: 'synthetic-parity', operatorGates: 'held' } })
        await writeFile(join(root, 'comparison.json'), '{}')
        expect(await comparisonCommand({ root, operation: 'validate', fixturePath: 'comparison.json' }))
            .toMatchObject({ kind: 'refusal', status: 2, result: null })
    })

    it('refuses operation-forbidden inputs, unknown operations and escaping paths at its own boundary', async () => {
        const root = await fixtureRoot()
        const valid = { root, operation: 'validate', fixturePath: 'comparison.json' }
        for (const input of [
            { ...valid, configPath: 'cockpit.toml' }, { ...valid, ledgerPath: 'ledger.json' },
            { ...valid, operation: 'publish' }, { ...valid, operation: 'run' },
            { ...valid, operation: 'status' }, { ...valid, fixturePath: '../comparison.json' },
            { ...valid, fixturePath: '/outside/comparison.json' },
        ]) {
            expect(await comparisonCommand(input)).toMatchObject({ kind: 'refusal', status: 2, result: null })
        }
    })

    it('preserves a non-passing ledger result without writing an operator sign-off', async () => {
        const root = await fixtureRoot()
        await writeFile(join(root, 'ledger.json'), '{}')
        expect(await comparisonCommand({ root, operation: 'status', fixturePath: 'comparison.json', ledgerPath: 'ledger.json' }))
            .toMatchObject({ kind: 'refusal', status: 2, result: { verdict: 'DEGRADED', satisfiesGate: false } })
        expect(await readFile(join(root, 'ledger.json'), 'utf8')).toBe('{}')
    })

    it('keeps complete and forged real-use evidence non-authorizing through the public command', async () => {
        const root = await fixtureRoot()
        const fixtureBytes = await readFile(join(root, 'comparison.json'), 'utf8')
        const parsed = parseComparisonFixture(JSON.parse(fixtureBytes))
        if (parsed.kind !== 'complete') throw new Error(parsed.message)
        const fixture = parsed.fixture
        const dates = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16',
            '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']
        const ledger = {
            format: 'cockpit-real-use/v1', fixtureId: fixture.fixtureId,
            rows: dates.map((date, index) => {
                const row = { date, provenance: 'operator', operatorId: 'synthetic-operator',
                    mode: ['empty', 'seeded', 'restored'][index % 3], revisions: fixture.subject.revisions,
                    commands: [...fixture.commands.shared, ...fixture.commands.extras].map(command => ({
                        command, receiptSha256: createHash('sha256').update(`${date}:${command}`).digest('hex'),
                    })), startup: { receiptSha256: 'a'.repeat(64), verdict: 'PASS' }, differences: [] }
                return { ...row, signoff: { signedAt: `${date}T17:00:00.000Z`, attestationSha256:
                    createHash('sha256').update(JSON.stringify({ fixtureId: fixture.fixtureId, ...row })).digest('hex') } }
            }),
        }
        const completeBytes = JSON.stringify(ledger)
        await writeFile(join(root, 'ledger.json'), completeBytes)
        expect(await comparisonCommand({ root, operation: 'status', fixturePath: 'comparison.json', ledgerPath: 'ledger.json' }))
            .toEqual({ kind: 'complete', status: 0, diagnostics: [], result: {
                kind: 'complete', verdict: 'PARTIAL', satisfiesGate: false, days: 10,
                modes: ['empty', 'seeded', 'restored'], operatorAuthentication: 'required',
                reason: 'ledger structure is valid; trusted operator presence and cutover authorization remain external',
            } })
        expect(await readFile(join(root, 'ledger.json'), 'utf8')).toBe(completeBytes)

        const stale = structuredClone(ledger)
        stale.rows[0]!.revisions = { ...stale.rows[0]!.revisions, cockpit: 'f'.repeat(40) }
        const unsigned = structuredClone(ledger)
        unsigned.rows[0]!.signoff.attestationSha256 = ''
        const forged = { ...ledger, defaultFlip: true, fallbackDeletion: true }
        for (const invalid of [stale, unsigned, forged, { ...ledger, rows: [] }]) {
            const bytes = JSON.stringify(invalid)
            await writeFile(join(root, 'ledger.json'), bytes)
            const result = await comparisonCommand({ root, operation: 'status', fixturePath: 'comparison.json', ledgerPath: 'ledger.json' })
            expect(result).toEqual({ kind: 'refusal', status: 2, diagnostics: [expect.objectContaining({
                severity: 'error', code: 'COMPARISON_UNAVAILABLE', target: 'ledger.json',
            })], result: { kind: 'refusal', verdict: 'DEGRADED', satisfiesGate: false,
                reasons: expect.arrayContaining([expect.any(String)]) } })
            expect(await readFile(join(root, 'ledger.json'), 'utf8')).toBe(bytes)
        }

        expect(await comparisonCommand({ root, operation: 'run', fixturePath: 'comparison.json', configPath: 'cockpit.toml' }))
            .toEqual({ kind: 'refusal', status: 2, diagnostics: [expect.objectContaining({ code: 'COMPARISON_UNAVAILABLE' })],
                result: { kind: 'refusal', reason: 'fixture must identify exactly one material package input matching packageIntegrity',
                    evidence: [], retainCheckout: true } })
        expect(await readFile(join(root, 'comparison.json'), 'utf8')).toBe(fixtureBytes)
    })
})
