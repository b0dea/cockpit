import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { syncGeneratedEnvironment } from '../src/generated-environment/command.js'
import { executeProbe } from '../src/environment-exec/execute.js'
import { surfaceSelftestExpectation, type SelftestProbeSpecification } from '../src/surfaces/selftest.js'

const fixture = resolve('fixtures/registries/generated-environment.toml')

async function syntheticSkillSources(names: readonly string[]): Promise<string> {
    const entry = await readFile(resolve('packages/cockpit/surfaces/skills/cockpit-setup.skill.md'), 'utf8')
    const procedure = '---\nloading: pull\nbudget: uncapped\n---\n\nInspect the synthetic product-owned verification target.\n'
    return names.flatMap((name) => [
        { path: `skills/${name}/SKILL.md`, bytes: entry.replace('name: cockpit-setup', `name: ${name}`) },
        { path: `skills/${name}/procedures/onboarding.md`, bytes: procedure },
    ]).map(({ path, bytes }) => `{ path = ${JSON.stringify(path)}, bytes = ${JSON.stringify(bytes)} }`).join(',\n  ')
}

export function createSelftestFixture(roots: string[]) {
    async function issuedApplication() {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-selftest-')))
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
name = "synthetic-skill"
feature = "skills"
source = "surfaces/synthetic-skill.json"
sources = [
  ${await syntheticSkillSources(['alpha', 'beta', 'zeta'])}
]
`
        const configPath = join(root, 'cockpit.toml')
        await writeFile(configPath, declaration)
        const outcome = await syncGeneratedEnvironment({ configPath })
        if (outcome.kind !== 'complete') throw new Error(outcome.diagnostics.map((row) => row.message).join('; '))
        return { root, configPath, application: outcome.result.application }
    }

    async function issuedCustomApplication(enforced = false) {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-selftest-custom-')))
        roots.push(root)
        await mkdir(join(root, 'app'), { recursive: true })
        await mkdir(join(root, 'fixtures'), { recursive: true })
        await mkdir(join(root, 'adapters'), { recursive: true })
        const evidenceBytes = '{"control":"synthetic paired probe"}\n'
        if (enforced) {
            await mkdir(join(root, 'evidence'), { recursive: true })
            await writeFile(join(root, 'evidence/rules.json'), evidenceBytes)
        }
        await writeFile(join(root, 'app/AGENTS.md'), 'Synthetic sibling instruction canary.\n')
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
        const outputBytes = 'synthetic custom rules\n'
        const output = [{
            path: 'app/custom-rules.md', bytes: outputBytes,
            sha256: createHash('sha256').update(outputBytes).digest('hex'), scope: 'always',
        }]
        await writeFile(join(root, 'adapters/synthetic.mjs'), `export async function renderRules(input) {
  if (input.harness !== "synthetic-harness" || input.feature !== "rules" || !Array.isArray(input.sources)) {
    process.stderr.write("MODULE_REJECTED_CONTROL\\n")
    throw new Error("invalid custom input")
  }
  return { kind: "complete", files: ${JSON.stringify(output)} }
}
/*${'x'.repeat(65_536)}*/
`)
        const capabilities = ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'].map((feature) => feature === 'rules'
            ? `{ feature = "rules", state = "${enforced ? 'enforced' : 'instructed'}", measured_on = "2026-09-26", spelling = "app/custom-rules.md", control = "controls/rules.json", mechanism = { module = "adapters/synthetic.mjs", export = "renderRules" }${enforced ? ', evidence = { reference = "evidence/rules.json", sha256 = "' + createHash('sha256').update(evidenceBytes).digest('hex') + '" }' : ''} }`
            : `{ feature = ${JSON.stringify(feature)}, state = "unavailable", measured_on = "2026-09-26", reason = "No synthetic ${feature} mechanism" }`)
        const baseDeclaration = (await readFile(fixture, 'utf8')).replace(
            'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
        ).replace(
            'purpose = "Synthetic application"', 'purpose = "Synthetic application"\nguides = ["AGENTS.md"]',
        ) + `
[[surfaces.overlays]]
name = "synthetic-skill"
feature = "skills"
source = "surfaces/synthetic-skill.json"
sources = [${await syntheticSkillSources(['alpha'])}]
`
        const customDeclaration = `
[[surfaces.overlays]]
name = "synthetic-rules"
feature = "rules"
source = "surfaces/synthetic-rules.json"
sources = [{ path = "rules/synthetic.md", bytes = "Read the synthetic sibling guide before editing.\\n" }]

[[surfaces.harnesses]]
name = "synthetic-harness"
features = ["rules", "mcp", "subagents", "skills", "hooks", "permissions"]
capabilities = [${capabilities.join(', ')}]
`
        const configPath = join(root, 'cockpit.toml')
        await writeFile(configPath, baseDeclaration + customDeclaration)
        const outcome = await syncGeneratedEnvironment({ configPath })
        if (outcome.kind !== 'complete') throw new Error(outcome.diagnostics.map((row) => row.message).join('; '))
        return { root, application: outcome.result.application }
    }

    function specifications(application: Awaited<ReturnType<typeof issuedApplication>>['application']): readonly SelftestProbeSpecification[] {
        const expectation = surfaceSelftestExpectation(application.surfaceSelftest)
        if (!expectation) throw new Error('selftest expectation unavailable')
        return expectation.cells.map((cell) => ({
            harness: cell.harness,
            capability: cell.capability,
            invocation: [cell.harness.kind === 'custom' ? '{node}' : '{executable}', '--probe', cell.capability, '{control}'],
            versionCommand: [cell.harness.kind === 'custom' ? '{node}' : '{executable}', '--version'],
            helpCommand: [cell.harness.kind === 'custom' ? '{node}' : '{executable}', '--help'],
            candidateCode: cell.capability === 'guard-firing' ? 'GUARD_FIRED'
                : cell.capability === 'skill-parity' ? 'SKILL_PARITY_CANARY' : 'INSTRUCTION_CANARY',
            brokenCode: 'BROKEN_CONTROL_REJECTED',
            unavailableCode: `${cell.capability.replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`,
            sample: cell.capability === 'skill-parity'
                ? { skill: cell.skill, features: ['name', 'trigger', 'body-load', 'tools', 'non-goals'] }
                : null,
        }))
    }

    // With `signIn`, each tool behaves like a signed-in CLI: it reads its sign-in from a file under
    // HOME and answers "Not logged in" without one, and it fails outright if the parent's
    // SYNTHETIC_TOKEN reached it.
    async function fakeHarnesses(root: string, sensitiveOutput: boolean | 'partial' | 'deep' = false, signIn = false): Promise<string> {
        const bin = join(root, 'harness-bin')
        await mkdir(bin)
        const script = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
${signIn ? `if (process.env.SYNTHETIC_TOKEN !== undefined) { process.stderr.write('SYNTHETIC_TOKEN_VISIBLE\\n'); process.exit(3) }
if (!process.env.HOME || !fs.existsSync(require('node:path').join(process.env.HOME, '.synthetic-sign-in'))) { process.stderr.write('Not logged in\\n'); process.exit(1) }` : ''}
if (args[0] === '--version') process.stdout.write(${JSON.stringify(sensitiveOutput === true ? 'token=version-canary\n' : 'synthetic 1.0.0\n')})
else if (args[0] === '--help') process.stdout.write('synthetic help\\n')
else {
  const capability = args[1]
  const bytes = fs.readFileSync(args[2], 'utf8')
  if (bytes.trim() === '{') { process.stderr.write('BROKEN_CONTROL_REJECTED\\n'); process.exitCode = 2 }
  else if (capability === 'guard-firing') { process.stderr.write('GUARD_FIRED\\n'); process.exitCode = 1 }
  else process.stdout.write((capability === 'skill-parity' ? 'SKILL_PARITY_CANARY' : 'INSTRUCTION_CANARY') + '\\n')
}
${sensitiveOutput === true ? `process.stdout.write(${JSON.stringify(JSON.stringify({ token: 'json-canary', nested: [{ api_key: 'nested-canary', message: 'public diagnostic' }] }) + '\n')})
process.stderr.write(${JSON.stringify('password=scalar-canary\n' + JSON.stringify({ credentials: { value: 'object-canary' } }) + '\n')})` : ''}
${typeof sensitiveOutput === 'string' ? `process.stdout.write(${JSON.stringify(sensitiveOutput === 'partial' ? 'MARKER\n{\n"credentials": {\n"value":"pretty-canary"\n}}\n' : '['.repeat(100) + '{"token":"deep-canary"}' + ']'.repeat(100) + '\n')})` : ''}
`
        for (const name of ['claude', 'codex', 'opencode']) {
            const path = join(bin, name)
            await writeFile(path, script)
            await chmod(path, 0o700)
        }
        return bin
    }

    function syntheticExecutableAuthorities(bin: string) {
        return {
            execute: executeProbe,
            testOnlyExecutableIdentities: {
                'Claude Code': [join(bin, 'claude')],
                Codex: [join(bin, 'codex')],
                OpenCode: [join(bin, 'opencode')],
            },
        } as const
    }

    async function syntheticOperatorApprovals(bin: string) {
        const executableSha256 = createHash('sha256').update(await readFile(join(bin, 'claude'))).digest('hex')
        const approved = new Map([
            ['Claude Code', join(bin, 'claude')],
            ['Codex', join(bin, 'codex')],
            ['OpenCode', join(bin, 'opencode')],
        ].map(([harness, path]) => [harness, { canonicalPath: path, sha256: executableSha256 }]))
        const requests: unknown[] = []
        return {
            requests,
            adapters: {
                execute: executeProbe,
                requestExecutableApproval: async (candidate: {
                    harness: 'Claude Code' | 'Codex' | 'OpenCode'
                    canonicalPath: string
                    sha256: string
                }) => {
                    requests.push(candidate)
                    const authority = approved.get(candidate.harness)
                    return authority?.canonicalPath === candidate.canonicalPath && authority.sha256 === candidate.sha256
                        ? authority.sha256 : undefined
                },
            },
        }
    }

    return {
        fakeHarnesses,
        issuedApplication,
        issuedCustomApplication,
        specifications,
        syntheticExecutableAuthorities,
        syntheticOperatorApprovals,
    }
}
