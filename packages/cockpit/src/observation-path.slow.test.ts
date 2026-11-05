import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createHealthCompositionFixture } from '../test-support/health-composition-fixture.js'
import { syncGeneratedEnvironment } from './environment/generated-application/sync.js'
import { COMPOSE_OWNERSHIP_FILE } from './environment/compose-ownership.js'
import { mcpApprovalDigest } from './surfaces/mcp.js'

const launcher = fileURLToPath(new URL('../bin/cockpit.mjs', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function cli(cwd: string, args: readonly string[], PATH: string, HOME = cwd) {
    const result = spawnSync(process.execPath, [launcher, ...args], {
        cwd, encoding: 'utf8', timeout: 120_000,
        env: { PATH, HOME, XDG_STATE_HOME: join(HOME, 'state'), TMPDIR: tmpdir() },
    })
    expect(result.error).toBeUndefined()
    return result
}

async function docsFixture() {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'cockpit-observation-path-')))
    roots.push(root)
    const caller = join(root, 'caller')
    const project = join(root, 'project')
    for (const bin of [caller, project, join(caller, 'node_modules/.bin'), join(project, 'node_modules/.bin'), join(root, 'relative')]) {
        mkdirSync(bin, { recursive: true })
        writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf poison > '${join(root, 'poison')}'\nexit 99\n`, { mode: 0o755 })
    }
    execFileSync('/usr/bin/git', ['init', '-q', project])
    const configPath = join(project, 'cockpit.toml')
    writeFileSync(configPath, ['[cockpit]', 'name = "synthetic"', 'siblings_root = "."',
        '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"',
        'var = "APP_DIR"', 'purpose = "Synthetic application"', '[ports]', 'bases = {}',
        '[docs]', 'living = ["README.md"]', ''].join('\n'))
    writeFileSync(join(project, 'README.md'), '# Synthetic application\n')
    return { root, caller, configPath }
}

describe('public observation command search paths', { timeout: 180_000 }, () => {
    it.each(['sync', 'check', 'doctor'])('observes surfaces-only checkout identity during %s without relative Git', async command => {
        const candidate = await docsFixture()
        if (command !== 'sync') {
            const published = cli(candidate.caller, ['sync', '--config', candidate.configPath, '--json'], '/usr/bin:/bin')
            expect(published.status, published.stdout + published.stderr).toBe(0)
        }
        const result = cli(candidate.caller, [command, '--config', candidate.configPath, '--json'], ':../relative:./node_modules/.bin:.:/usr/bin:/bin:')
        expect(result.status, result.stdout + result.stderr).toBe(0)
        const report = JSON.parse(result.stdout)
        expect(report.diagnostics.filter((row: { severity: string }) => row.severity === 'error').map((row: { code: string }) => row.code)).toEqual(
            command === 'doctor' ? ['ENVIRONMENT_NOT_DECLARED', 'GIT_STATE_UNHEALTHY'] : [],
        )
        if (command === 'doctor') {
            expect(report.result).toMatchObject({ freshness: { local: { kind: 'complete', status: 0 } }, surfaceOverrides: { kind: 'complete' } })
            expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_SEARCH_PATH_RELATIVE' }))
        }
        expect(existsSync(join(candidate.root, 'poison'))).toBe(false)
    })

    it('checks another repository without executing relative package-manager bin entries', async () => {
        const candidate = await docsFixture()
        const result = cli(candidate.caller, ['docs', 'check', '--config', candidate.configPath, '--json'], ':../relative:./node_modules/.bin:.:/usr/bin:/bin:')
        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({ diagnostics: [], result: { repositories: [{ livingDocuments: 1 }], findings: 0 } })
        expect(existsSync(join(candidate.root, 'poison'))).toBe(false)
    })

    it('keeps malformed paths in the command JSON refusal and keeps help independent of PATH', async () => {
        const candidate = await docsFixture()
        for (const PATH of ['', './node_modules/.bin', ':../relative:.:', '/usr/bin/../bin:/bin']) {
            const result = cli(candidate.caller, ['docs', 'check', '--config', candidate.configPath, '--json'], PATH)
            expect(result.status, PATH).toBe(2)
            expect(JSON.parse(result.stdout).diagnostics, PATH).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_UNAVAILABLE' }))
        }
        for (const args of [['--help'], ['--version'], ['doctor', '--help']]) {
            const result = cli(candidate.caller, args, '')
            expect(result.status, result.stderr).toBe(0)
            expect(result.stdout.length).toBeGreaterThan(0)
            expect(result.stderr).toBe('')
        }
        expect(existsSync(join(candidate.root, 'poison'))).toBe(false)
    })

    it('observes doctor Git and Compose with absolute tools while warning only about the CLI PATH', async () => {
        const candidate = await createHealthCompositionFixture(roots)({ configuredRuntime: true, unseeded: true })
        await rm(join(candidate.checkout, COMPOSE_OWNERSHIP_FILE))
        const sibling = join(candidate.checkout, 'siblings/api')
        await writeFile(join(sibling, '.mcp.json'), JSON.stringify({ mcpServers: { synthetic: { command: 'git' } } }))
        const approval = mcpApprovalDigest({ command: 'git', args: [], cwd: sibling, envNames: [] }, candidate.checkout)
        await writeFile(candidate.configPath, `${await readFile(candidate.configPath, 'utf8')}
[sibling.derives]
mcp_sources = [{ path = ".mcp.json", provenance = { source = "synthetic declaration", observed_on = "2026-10-23", kind = "declared", reason = "Synthetic MCP discovery" } }]
[mcp.approved]
synthetic = "${approval}"
`)
        const published = await syncGeneratedEnvironment({ configPath: candidate.configPath })
        expect(published, JSON.stringify(published.diagnostics)).toMatchObject({ kind: 'complete' })
        const poison = join(candidate.root, 'poison')
        for (const bin of [candidate.checkout, join(candidate.checkout, 'node_modules/.bin'), join(candidate.checkout, '../relative')]) {
            mkdirSync(bin, { recursive: true })
            for (const name of ['git', 'docker', 'codex', 'claude', 'opencode']) {
                await writeFile(join(bin, name), `#!/bin/sh\nprintf poison > '${poison}'\nexit 99\n`, { mode: 0o755 })
            }
        }
        mkdirSync(join(candidate.checkout, 'workorders'))
        const result = cli(candidate.checkout, ['doctor', '--config', candidate.configPath, '--json'], `:../relative:./node_modules/.bin:.:${candidate.root}:/usr/bin:/bin:`, candidate.home)
        expect(result.status, result.stdout + result.stderr).toBe(0)
        const report = JSON.parse(result.stdout)
        expect(report.result).toMatchObject({ freshness: { local: { kind: 'complete', status: 0 } }, surfaceOverrides: { kind: 'complete' } })
        expect(report.result.checks).toContainEqual(expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', verdict: 'pass' }))
        expect(report.result.checks).toContainEqual(expect.objectContaining({ code: 'HARNESS_SURFACE_UNAVAILABLE', verdict: 'pass' }))
        expect(report.result.checks).toContainEqual(expect.objectContaining({ code: 'MOUNT_MATERIALIZATION_UNAVAILABLE', verdict: 'not-applicable' }))
        expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_SEARCH_PATH_RELATIVE',
            message: expect.stringContaining('This CLI process') }))
        expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'EVALUATOR_UNAVAILABLE' }))
        expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_COMMAND_UNRESOLVED', target: 'synthetic' }))
        const mcp = report.diagnostics.find((row: { code: string; target: string }) => row.code === 'MCP_COMMAND_UNRESOLVED' && row.target === 'synthetic')
        expect(mcp.message).toContain('an empty entry, which is the working directory')
        expect(mcp.message).toContain('excludes from observation')
        expect(mcp.message).toMatch(/git is at \/\S+\/git among the absolute entries/)
        expect(mcp.message).not.toContain('no tool can start')
        for (const code of ['EVIDENCE_UNAVAILABLE', 'COMPOSE_TOPOLOGY_UNAVAILABLE', 'LIFECYCLE_EVIDENCE_INVALID']) {
            expect(report.diagnostics.map((row: { code: string }) => row.code)).not.toContain(code)
        }
        expect(existsSync(poison)).toBe(false)
    })

    it.each(['check', 'preflight'])('runs %s with a Compose runtime under the same PATH as an absolute one', async command => {
        const candidate = await createHealthCompositionFixture(roots)({ configuredRuntime: true, unseeded: true })
        await rm(join(candidate.checkout, COMPOSE_OWNERSHIP_FILE))
        const absolutePath = `${candidate.root}:/usr/bin:/bin`
        const published = cli(candidate.checkout, ['sync', '--config', candidate.configPath, '--json'], absolutePath, candidate.home)
        expect(published.status, published.stdout + published.stderr).toBe(0)
        const poison = join(candidate.root, 'poison')
        for (const bin of [candidate.checkout, join(candidate.checkout, 'node_modules/.bin'), join(candidate.checkout, '../relative')]) {
            mkdirSync(bin, { recursive: true })
            for (const name of ['git', 'docker']) await writeFile(join(bin, name), `#!/bin/sh\nprintf poison > '${poison}'\nexit 99\n`, { mode: 0o755 })
        }
        const codes = (PATH: string) => {
            const result = cli(candidate.checkout, [command, '--config', candidate.configPath, '--json'], PATH, candidate.home)
            const report = JSON.parse(result.stdout)
            return { status: result.status, codes: report.diagnostics.map((row: { code: string }) => row.code).filter((code: string) => code !== 'GUARD_SEARCH_PATH_RELATIVE').sort() }
        }
        const relative = codes(`:../relative:./node_modules/.bin:.:${absolutePath}:`)
        expect(relative).toEqual(codes(absolutePath))
        // Check passes outright; preflight stops at the stack that never came up, not at the search path.
        expect(relative.status).toBe(command === 'check' ? 0 : 2)
        expect(relative.codes).toEqual(command === 'check' ? expect.not.arrayContaining(['COMPOSE_TOPOLOGY_UNAVAILABLE']) : expect.arrayContaining(['STATE_UNSEEDED']))
        expect(existsSync(poison)).toBe(false)
    })
})
