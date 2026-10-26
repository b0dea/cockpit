import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { executeProbe } from '../environment-exec/execute.js'
import { syncGeneratedEnvironment } from '../generated-environment/command.js'
import { runSurfaceSelftestCommand } from '../selftest/command.js'
import { surfaceSelftestExpectation, type SelftestProbeSpecification } from './selftest.js'

const fixture = resolve('fixtures/registries/generated-environment.toml')
const roots: string[] = []
const inertForeignImport = 'import "./foreign-instruction.md"'

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function issuedApplication() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-native-loading-')))
    roots.push(root)
    await mkdir(join(root, 'app'), { recursive: true })
    await mkdir(join(root, 'fixtures'), { recursive: true })
    await writeFile(join(root, 'app/AGENTS.md'), 'Synthetic sibling instruction canary.\n')
    await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    const declaration = (await readFile(fixture, 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
    ).replace(
        'purpose = "Synthetic application"', 'purpose = "Synthetic application"\nguides = ["AGENTS.md"]',
    ) + `
[[surfaces.overlays]]
name = "foreign-import-control"
feature = "rules"
source = "surfaces/foreign-import-control.json"
sources = [{ path = "rules/foreign-import.md", bytes = ${JSON.stringify(`${inertForeignImport}\n`)} }]
`
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, declaration)
    const outcome = await syncGeneratedEnvironment({ configPath })
    if (outcome.kind !== 'complete') throw new Error(outcome.diagnostics.map((row) => row.message).join('; '))
    return { root, application: outcome.result.application }
}

function probeSpecifications(
    application: Awaited<ReturnType<typeof issuedApplication>>['application'],
): readonly SelftestProbeSpecification[] {
    const expectation = surfaceSelftestExpectation(application.surfaceSelftest)
    if (!expectation) throw new Error('selftest expectation unavailable')
    return expectation.cells.map((cell) => ({
        harness: cell.harness,
        capability: cell.capability,
        invocation: ['{executable}', '--probe', cell.capability, '{control}'],
        versionCommand: ['{executable}', '--version'],
        helpCommand: ['{executable}', '--help'],
        candidateCode: cell.capability === 'guard-firing' ? 'GUARD_FIRED'
            : cell.capability === 'skill-parity' ? 'SKILL_PARITY_CANARY' : 'INSTRUCTION_CANARY',
        brokenCode: 'BROKEN_CONTROL_REJECTED',
        unavailableCode: `${cell.capability.replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`,
        sample: cell.capability === 'skill-parity'
            ? { skill: cell.skill, features: ['name', 'trigger', 'body-load', 'tools', 'non-goals'] }
            : null,
    }))
}

async function controlledHarnesses(root: string): Promise<string> {
    const bin = join(root, 'harness-bin')
    await mkdir(bin)
    const script = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === '--version') process.stdout.write('synthetic 1.0.0\\n')
else if (args[0] === '--help') process.stdout.write('synthetic help\\n')
else {
  const capability = args[1]
  const bytes = fs.readFileSync(args[2], 'utf8')
  if (bytes.trim() === '{') { process.stderr.write('BROKEN_CONTROL_REJECTED\\n'); process.exitCode = 2 }
  else if (path.basename(process.argv[1]) === 'codex' && capability === 'instruction-loading' && bytes.includes(${JSON.stringify(inertForeignImport)})) {
    process.stdout.write('INSTRUCTION_LOADING_UNAVAILABLE\\n')
  } else if (path.basename(process.argv[1]) === 'codex' && capability === 'instruction-loading') {
    process.stdout.write('INSTRUCTION_CANARY\\n')
  } else process.stdout.write(capability.replaceAll('-', '_').toUpperCase() + '_UNAVAILABLE\\n')
}
`
    for (const name of ['claude', 'codex', 'opencode']) {
        const path = join(bin, name)
        await writeFile(path, script)
        await chmod(path, 0o700)
    }
    return bin
}

function selectedCodexInstructions(application: Awaited<ReturnType<typeof issuedApplication>>['application']): string {
    const entry = application.surfaceSelftest.entries.find((row) => row.path === 'AGENTS.md' && row.harnesses.includes('codexcli'))
    if (!entry || entry.kind !== 'shared-region' || entry.region.format !== 'markdown-delimited') {
        throw new Error('generated Codex instruction entry unavailable')
    }
    return entry.region.bytes
}

describe('native instruction loading controls', () => {
    it('does not promote foreign inert import syntax and preserves unavailable native runs', async () => {
        const { root, application } = await issuedApplication()
        const specifications = probeSpecifications(application)
        expect(selectedCodexInstructions(application)).toContain(inertForeignImport)

        const bin = await controlledHarnesses(root)
        const controlled = await runSurfaceSelftestCommand({
            application,
            root,
            specifications,
            env: { PATH: bin },
        }, {
            execute: executeProbe,
            testOnlyExecutableIdentities: {
                'Claude Code': [join(bin, 'claude')],
                Codex: [join(bin, 'codex')],
                OpenCode: [join(bin, 'opencode')],
            },
        })
        expect(controlled).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (controlled.kind !== 'complete') return
        const codexLoading = controlled.bundle.records.find((row) => row.harness.kind === 'builtin'
            && row.harness.target === 'codexcli' && row.capability === 'instruction-loading')
        expect(codexLoading).toEqual(expect.objectContaining({
            kind: 'evidence',
            verdict: 'unavailable',
            candidateCode: 'INSTRUCTION_LOADING_UNAVAILABLE',
            events: expect.objectContaining({
                brokenControl: expect.objectContaining({ result: 'rejected', code: 'BROKEN_CONTROL_REJECTED' }),
                candidateControl: expect.objectContaining({ result: 'allowed', code: 'INSTRUCTION_LOADING_UNAVAILABLE' }),
            }),
        }))
        expect(controlled.evidence.errors).toEqual([])
        expect(controlled.bundle.records.every((row) => row.kind === 'evidence' && row.verdict === 'unavailable')).toBe(true)

        const emptyPath = join(root, 'empty-bin')
        await mkdir(emptyPath)
        const unavailable = await runSurfaceSelftestCommand({ application, root, specifications, env: { PATH: emptyPath } })
        expect(unavailable).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (unavailable.kind !== 'complete') return
        expect(unavailable.bundle.records).toHaveLength(specifications.length)
        expect(unavailable.bundle.records.every((row) => row.kind === 'human_needed'
            && row.reason === 'executable_missing')).toBe(true)
        expect(unavailable.bundle.records.find((row) => row.harness.kind === 'builtin'
            && row.harness.target === 'codexcli' && row.capability === 'instruction-loading')).toEqual(expect.objectContaining({
            kind: 'human_needed',
            reason: 'executable_missing',
            operatorAction: 'Install Codex and rerun its instruction-loading probe',
        }))
        expect(unavailable.evidence.evidence).toEqual([])
        expect(unavailable.evidence.pending).toHaveLength(specifications.length)
    }, 180_000)
})
