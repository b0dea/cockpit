import { spawnSync } from 'node:child_process'
import { readFile, rm, stat, writeFile, mkdir, realpath, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

import { CockpitConfig } from '../schema.js'
import { cockpitId, publicationCockpitId } from '../environment/identity.js'
import { mcpApprovalDigest } from '../surfaces/mcp.js'
import { parseOwnershipManifest } from '../surfaces/ownership.js'
import { SURFACE_TARGETS } from '../surfaces/harness-registry.js'
import {
    generatedApplicationProjection,
    observeGeneratedApplicationSurfaces,
    projectWorkApplicationAuthorities,
    consumeWorkApplicationAuthorities,
} from '../environment/generated-application.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './command.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'

const { roots, cleanup, surfaceConsumer, digest, runGeneratedGuard, bytes } = createGeneratedCommandFixture()
afterEach(cleanup)

describe('generated environment command', () => {
describe('public surface publication transaction', () => {
        it('serializes one MCP collection exactly and guards a selected sibling root', async () => {
            const estate = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-selected-sibling-estate-')))
            roots.push(estate)
            const outside = join(estate, 'external')
            await mkdir(outside)
            await writeFile(join(outside, '.env.example'), 'SYNTHETIC_TOKEN=\n')
            await writeFile(join(outside, '.env'), 'SYNTHETIC_TOKEN=value\n')
            const fixture = await surfaceConsumer('native-mcp', {
                rules: true, mcp: { command: '/usr/bin/printenv', envNames: ['SYNTHETIC_TOKEN'] }, siblingDirectory: outside, parentDirectory: estate,
            })
            expect(dirname(fixture.root)).toBe(estate)
            expect(dirname(outside)).toBe(estate)
            expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
            await writeFile(join(fixture.root, 'app/package-lock.json'), '{}\n')
            const declaration = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            declaration.cockpit.siblings_root = estate
            declaration.sibling.find(sibling => sibling.slug === 'app')!.dir = relative(estate, join(fixture.root, 'app'))
            // Every shipped tool is listed so each tool's grant spelling is checked.
            declaration.surfaces.tools = [...SURFACE_TARGETS]
            // A person approves each server here, so only the one whose digest is recorded is enabled.
            declaration.autonomy.mcp_approve = 'person'
            await writeFile(fixture.configPath, stringifyToml(CockpitConfig.parse(declaration)))
            await writeFile(join(outside, '.mcp.json'), JSON.stringify({ mcpServers: {
                'approved-server': { command: '/usr/bin/printenv', env: { SYNTHETIC_TOKEN: '${SYNTHETIC_TOKEN}' } },
                'unapproved-server': { command: '/usr/bin/true' },
            } }))

            const synchronized = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synchronized, JSON.stringify(synchronized.diagnostics)).toMatchObject({ kind: 'complete' })
            const claude = JSON.parse(await readFile(join(fixture.root, '.mcp.json'), 'utf8')) as {
                mcpServers: Record<string, { command: string; args: string[] }>
            }
            const settings = JSON.parse(await readFile(join(fixture.root, '.claude/settings.json'), 'utf8')) as {
                enabledMcpjsonServers: string[]
                disabledMcpjsonServers: string[]
                permissions: { deny?: string[]; allow?: string[] }
            }
            const codex = parseToml(await readFile(join(fixture.root, '.codex/config.toml'), 'utf8')) as {
                mcp_servers: Record<string, { enabled?: boolean }>
                sandbox_mode?: string
                sandbox_workspace_write?: { writable_roots?: string[] }
                default_permissions?: unknown
                permissions?: unknown
            }
            const ownershipBytes = await readFile(join(fixture.root, '.cockpit/generated-environment-ownership.json'), 'utf8')
            const publishedOwnership = JSON.parse(ownershipBytes) as {
                cockpitId: string
                source: { sha256: string }
            }
            const ownerId = publishedOwnership.cockpitId
            expect(ownerId).toBe(publicationCockpitId({ name: 'generated-environment' }))
            expect(parseOwnershipManifest(ownershipBytes, {
                root: fixture.root,
                cockpitId: publicationCockpitId({ name: 'generated-environment' }),
                configPath: fixture.configPath,
            })).toMatchObject({ kind: 'complete' })
            expect(publishedOwnership.source.sha256).toBe(digest(await readFile(fixture.configPath)))
            const openCodeBytes = await readFile(join(fixture.root, 'opencode.jsonc'), 'utf8')
            const cursorGrant = await readFile(join(fixture.root, '.cursor/cli.json'), 'utf8')
            const grokGrant = await readFile(join(fixture.root, '.grok/config.toml'), 'utf8')
            const grokPermissions = parseToml(grokGrant) as { permission: { allow: string[] } }
            expect(openCodeBytes).toContain(`/* cockpit:owner:${ownerId}:start */`)
            const openCode = JSON.parse(openCodeBytes
                .replace(`/* cockpit:owner:${ownerId}:start */`, '')
                .replace(`/* cockpit:owner:${ownerId}:end */`, '')) as {
                $schema: string
                mcp: Record<string, { enabled: boolean }>
                permission: { external_directory: Record<string, 'allow'>; read: Record<string, 'deny'> }
            }
            expect(Object.keys(claude.mcpServers).sort()).toEqual(['approved-server', 'unapproved-server'])
            expect(settings.enabledMcpjsonServers).toEqual(['approved-server'])
            // Claude Code ignores `disabled` in `.mcp.json`; only this list keeps the server off.
            expect(settings.disabledMcpjsonServers).toEqual(['unapproved-server'])
            expect(synchronized.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'MCP_NOT_APPROVED', target: 'unapproved-server' }))
            expect(claude.mcpServers['approved-server']!.args).toEqual([expect.stringMatching(/^\.cockpit\/mcp\/[a-f0-9]{64}\.sh$/)])
            // Claude's Read, Grep and Glob bypass the guard hook, so the read denial is native: every
            // secrets directory, and each declared instance by its clone-independent sibling suffix.
            expect(settings.permissions.deny).toEqual(['Read(//**/.secrets/**)', 'Read(//**/app/.env)', 'Read(//**/external/.env)'])
            // Claude's default mode runs no Bash without a rule, so the commands the skills tell an
            // agent to run are allowed by prefix. A policy-decided command such as sync or work accept is
            // allowed too, because the guard's ask still wins; always-person and destructive ones keep prompting.
            expect(settings.permissions.allow).toEqual(expect.arrayContaining([
                'Bash(npx --no cockpit test-run *)', 'Bash(./node_modules/.bin/cockpit check *)', 'Bash(npx --no cockpit sync *)',
                'Bash(npx --no cockpit work accept *)', 'Bash(npx --no cockpit reset * --apply)',
            ]))
            expect(settings.permissions.allow!.filter(rule => /cockpit (down|init|sibling|session|browser debugger)\b/.test(rule))).toEqual([])
            expect(Object.keys(codex.mcp_servers).sort()).toEqual(['approved-server', 'unapproved-server'])
            expect([codex.mcp_servers['approved-server']?.enabled !== false, codex.mcp_servers['unapproved-server']?.enabled]).toEqual([true, false])
            expect(codex).toMatchObject({
                sandbox_mode: 'workspace-write',
                sandbox_workspace_write: { writable_roots: ['../../external', '../app'] },
            })
            // The roots are the cockpit's wherever the command runs: from inside the outside sibling,
            // check still matches what sync wrote from the cockpit root.
            const workingDirectory = process.cwd()
            process.chdir(fixture.siblingDirectory)
            try {
                expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            } finally {
                process.chdir(workingDirectory)
            }
            expect(codex).not.toHaveProperty('default_permissions')
            expect(codex).not.toHaveProperty('permissions')
            expect(Object.fromEntries(Object.entries(openCode.mcp).map(([name, server]) => [name, server.enabled]))).toEqual({
                'approved-server': true, 'unapproved-server': false,
            })
            expect(openCode.permission.external_directory).toEqual({
                '{file:.cockpit/local/opencode-grant-app}/**': 'allow',
                '{file:.cockpit/local/opencode-grant-external}/**': 'allow',
            })
            // OpenCode reads the absolute directory from the machine-local file the pattern names.
            expect(await readFile(join(fixture.root, '.cockpit/local/opencode-grant-external'), 'utf8')).toBe(await realpath(fixture.siblingDirectory))
            // OpenCode's native read is denied the same paths; its patterns are worktree-relative and
            // its `*` crosses directories. OpenCode adds the exact `$schema` value when it is missing,
            // which once made every later check report a conflict, so cockpit writes it itself.
            expect(openCode.permission.read).toEqual({
                '*/.secrets/*': 'deny', '*/app/.env': 'deny', '*/external/.env': 'deny',
                '.secrets/*': 'deny', 'app/.env': 'deny', 'external/.env': 'deny',
            })
            expect(openCode.$schema).toBe('https://opencode.ai/config.json')
            expect(openCodeBytes.startsWith(`{/* cockpit:owner:${ownerId}:start */"$schema":"https://opencode.ai/config.json",`)).toBe(true)
            expect(cursorGrant).toContain('../external')
            expect(cursorGrant).toContain('app/**')
            expect(cursorGrant).not.toContain(estate)
            expect(cursorGrant).toContain('Read')
            expect(cursorGrant).toContain('Write')
            expect(grokGrant).toContain('../external')
            expect(grokGrant).toContain('app/**')
            expect(grokPermissions.permission.allow).toEqual([
                'Edit(../external/**)', 'Edit(app/**)', 'Read(../external/**)', 'Read(app/**)',
            ])
            expect(grokGrant).toContain('Read(')
            expect(grokGrant).toContain('Edit(')

            const approved = claude.mcpServers['approved-server']!
            const wrapper = approved.args[0]!
            expect((await stat(join(fixture.root, wrapper))).mode & 0o111).toBe(0)
            const launched = spawnSync(approved.command, approved.args, {
                cwd: fixture.root, env: { PATH: '/usr/bin:/bin', SYNTHETIC_TOKEN: 'named-value', UNDECLARED: 'excluded' }, encoding: 'utf8',
            })
            expect(launched).toMatchObject({ status: 0, stdout: 'PATH=/usr/bin:/bin\nSYNTHETIC_TOKEN=named-value\n' })
            expect(launched.stdout).not.toContain('UNDECLARED')

            const denied = runGeneratedGuard(fixture.root, join(outside, '.env'))
            expect(denied.stdout, JSON.stringify(denied)).toContain('permissionDecision":"deny')
            expect(runGeneratedGuard(fixture.root, join(outside, '.env.example'))).toMatchObject({ status: 0, stdout: '' })
            expect(runGeneratedGuard(fixture.root, join(fixture.root, '..', 'unlisted', '.env'))).toMatchObject({
                status: 2, stderr: expect.stringContaining('Guard path escapes configured roots.'),
            })
        })

        it('denies native reads of every declared instance whatever its mount, including one in the cockpit root', async () => {
            const estate = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-read-denial-estate-')))
            roots.push(estate)
            const fixture = await surfaceConsumer('read-denials', { parentDirectory: estate })
            const hosted = join(estate, 'hosted')
            await mkdir(hosted)
            await writeFile(join(hosted, '.env.example'), 'SYNTHETIC_TOKEN=\n')
            await writeFile(join(fixture.root, 'local[1].env.example'), 'SYNTHETIC_TOKEN=\n')
            expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
            await writeFile(join(fixture.root, 'app/package-lock.json'), '{}\n')
            const declaration = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            declaration.cockpit.siblings_root = estate
            declaration.sibling.find(sibling => sibling.slug === 'app')!.dir = relative(estate, join(fixture.root, 'app'))
            // A host-mounted sibling has no directory grant, and the root sibling is the cockpit checkout itself.
            declaration.sibling.push(CockpitConfig.shape.sibling.element.parse({ slug: 'hosted', dir: 'hosted', mount: 'host', host_reason: 'Synthetic host-only service', gate: 'operator', acquire: 'none',
                var: 'HOSTED_DIR', purpose: 'Synthetic host-mounted service', environment_files: [{ template: '.env.example', instance: '.env' }] }))
            declaration.sibling.push(CockpitConfig.shape.sibling.element.parse({ slug: 'self', dir: relative(estate, fixture.root), mount: 'none', acquire: 'none',
                var: 'SELF_DIR', purpose: 'The cockpit checkout itself', environment_files: [{ template: 'local[1].env.example', instance: 'local[1].env' }] }))
            await writeFile(fixture.configPath, stringifyToml(CockpitConfig.parse(declaration)))

            const synchronized = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synchronized, JSON.stringify(synchronized.diagnostics)).toMatchObject({ kind: 'complete' })
            const settings = JSON.parse(await readFile(join(fixture.root, '.claude/settings.json'), 'utf8')) as { permissions: { deny?: string[] } }
            // `/` anchors a rule at the project root; measured on Claude Code 2.1.314, 2026-10-30, with an unruled control beside it.
            expect(settings.permissions.deny).toEqual(['Read(//**/.secrets/**)', 'Read(//**/app/.env)', 'Read(//**/hosted/.env)', 'Read(/local?1?.env)'])
        })

        // cockpit renders no browser runner, so the browser is always a local launch: no playwright
        // MCP server or browser skill is published, and the work authorities still carry the project.
        it.each([
            { name: 'a nested configuration', layout: 'nested', preapproved: true, serialized: false, openCode: true },
            { name: 'a linked worktree without preapproval', layout: 'worktree', preapproved: false, serialized: true, openCode: false },
            { name: 'a standalone directory', layout: 'standalone', preapproved: true, serialized: false, openCode: true },
        ])('publishes source-bound browser and testing surfaces through the canonical transaction ($name)', async variant => {
            let mainCheckout: string | undefined
            let currentCheckoutPath: string | undefined
            if (variant.layout !== 'standalone') {
                const estate = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-checkouts-')))
                roots.push(estate)
                mainCheckout = join(estate, 'main')
                expect(spawnSync('git', ['init', '--quiet', mainCheckout]).status).toBe(0)
                currentCheckoutPath = mainCheckout
                if (variant.layout === 'worktree') {
                    expect(spawnSync('git', ['-C', mainCheckout, '-c', 'user.name=Synthetic Maintainer',
                        '-c', 'user.email=maintainer@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Initialize synthetic checkout']).status).toBe(0)
                    currentCheckoutPath = join(estate, 'linked')
                    expect(spawnSync('git', ['-C', mainCheckout, 'worktree', 'add', '--quiet', '--detach', currentCheckoutPath]).status).toBe(0)
                }
            }
            const fixture = await surfaceConsumer('browser-testing', { parentDirectory: currentCheckoutPath })
            mainCheckout ??= fixture.root
            currentCheckoutPath ??= fixture.root
            const lockBytes = JSON.stringify({ lockfileVersion: 3, packages: {
                '': { dependencies: { '@playwright/test': '1.2.3' } }, 'node_modules/@playwright/test': { version: '1.2.3' },
            } }) + '\n'
            const manifestBytes = JSON.stringify({ dependencies: { '@playwright/test': '1.2.3' } })
            const projectSha256 = digest(lockBytes)
            const mcpImage = `synthetic.invalid/browser-mcp@sha256:${'b'.repeat(64)}`
            const artifactPaths = ['.browser/mcp', '.browser/cli', '.browser/auth']
            await writeFile(join(fixture.root, 'app/package-lock.json'), lockBytes)
            await writeFile(join(fixture.root, 'app/package.json'), manifestBytes)
            await writeFile(join(fixture.root, 'browser.mcp.json'), JSON.stringify({ mcpServers: {
                playwright: { command: 'docker', args: ['run', '--rm', '-i', mcpImage, '--endpoint', 'ws://localhost:3001/'] },
                unrelated: { command: '/usr/bin/true' },
            } }))
            const declaration = await readFile(fixture.configPath, 'utf8')
            const environment = `[environment]
addressing = "hostname"
authentication = "${variant.serialized ? 'real' : 'bypassed'}"
posture_requirements = [{ requirement = "synthetic-browser", addressing = "hostname", authentication = "${variant.serialized ? 'real' : 'bypassed'}" }]
generated_host_paths = ${JSON.stringify(artifactPaths)}

`
            const additions = `
[[sibling]]
slug = "browser-source"
dir = "."
mount = "none"
acquire = "none"
var = "BROWSER_SOURCE_DIR"
purpose = "Synthetic browser declaration"

[sibling.derives]
mcp_sources = [{ path = "browser.mcp.json", provenance = { source = "synthetic declaration", observed_on = "2026-10-23", kind = "declared", reason = "Synthetic browser transport" } }]

[mcp.approved]
playwright = "${mcpApprovalDigest({ command: 'docker', args: ['run', '--rm', '-i', mcpImage, '--endpoint', 'ws://localhost:3001/'], cwd: fixture.root, envNames: [] }, fixture.root)}"

[browser]
engine = "chromium"
harnesses = [{ target = "claudecode", version = "2.1.220" }, { target = "codexcli", version = "0.149.0" }${variant.openCode ? ', { target = "opencode", version = "1.18.15" }' : ''}]
images = { mcp = { reference = ${JSON.stringify(mcpImage)}, driver_version = "1.2.3" } }
project = { manifest = "app/package.json", manifest_sha256 = ${JSON.stringify(digest(manifestBytes))}, lockfile = "app/package-lock.json", sha256 = ${JSON.stringify(projectSha256)}, driver_version = "1.2.3" }
max_clients = 4
proxy = { host_variable = "BROWSER_PORT", server_port = 3000, proxy_port = 3001, allowed_hosts = ["localhost:3001"] }
resolver = [{ hostname = "app.example.localhost", address = "127.0.0.1" }]
authentication = ${variant.serialized ? '{ policy = "serialized", states = [{ worker = "shared", path = ".browser/auth/shared.json" }] }' : '{ policy = "none", states = [] }'}
data = { mode = "empty", isolated = true, reaches_production = false }
request_preapproval = true
artifacts = { mcp = ".browser/mcp", cli = ".browser/cli", auth = ".browser/auth" }

[testing]
stages = [{ id = "unit", command = ["npm", "test"], requires_stack = false }]
gates = [{ id = "focused", tier = "targeted", stages = ["unit"], changes = "Isolated behavior" }]
native_hooks = { install = "inspect" }
`
            if (variant.serialized) {
                await mkdir(join(fixture.root, '.browser/auth'), { recursive: true })
                await writeFile(join(fixture.root, '.browser/auth/shared.json'), '{}', { mode: 0o600 })
            }
            const browserDeclaration = additions.replace('request_preapproval = true', `request_preapproval = ${variant.preapproved}`)
            await writeFile(fixture.configPath, `${declaration.replace('APP_HOST_PORT = 4100', 'APP_HOST_PORT = 4100\nBROWSER_PORT = 3001')}\n${environment}${browserDeclaration}`)
            const stateHome = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-testing-state-')))
            roots.push(stateHome)
            const priorHome = process.env.HOME
            const priorXdgStateHome = process.env.XDG_STATE_HOME
            process.env.HOME = stateHome
            process.env.XDG_STATE_HOME = join(stateHome, 'state')
            try {
                const synchronized = await syncGeneratedEnvironment({ configPath: fixture.configPath })
                expect(synchronized, JSON.stringify(synchronized.diagnostics)).toMatchObject({ kind: 'complete' })
                if (synchronized.kind !== 'complete') throw new Error('browser and testing surfaces were not synchronized')
                const application = generatedApplicationProjection(synchronized.result.application)
                if (!application) throw new Error('generated application projection was not issued')
                const installedSkills = application.surfaceSelftest.entries.filter(entry => entry.kind === 'file'
                    && entry.path.startsWith('.claude/skills/') && entry.path.endsWith('/SKILL.md'))
                let installedFrontmatterBytes = 0
                for (const entry of installedSkills) {
                    const published = await readFile(join(fixture.root, entry.path), 'utf8')
                    expect(published).toMatch(/^---\n/)
                    const end = published.indexOf('\n---\n', 4)
                    expect(end).toBeGreaterThan(4)
                    installedFrontmatterBytes += Buffer.byteLength(published.slice(4, end))
                }
                const installedInventory = application.surfaceSelftest.entries.filter(entry => entry.kind === 'file'
                    && entry.path.endsWith('/SKILL.md')).flatMap(entry => entry.harnesses.map(target => ({
                        target, path: entry.path, sha256: entry.kind === 'file' ? entry.sha256 : '',
                    }))).sort((left, right) => {
                        const a = `${left.target}\0${left.path}`
                        const b = `${right.target}\0${right.path}`
                        return a < b ? -1 : a > b ? 1 : 0
                    })
                const frontmatterByTarget = new Map<string, number>()
                for (const row of installedInventory) {
                    const published = await readFile(join(fixture.root, row.path), 'utf8')
                    expect(published).toMatch(/^---\n/)
                    const end = published.indexOf('\n---\n', 4)
                    expect(end).toBeGreaterThan(4)
                    frontmatterByTarget.set(row.target, (frontmatterByTarget.get(row.target) ?? 0)
                        + Buffer.byteLength(published.slice(4, end)))
                }
                const skillHealth = observeGeneratedApplicationSurfaces(application)?.find(row => row.code === 'SKILL_BUDGET_UNAVAILABLE')
                expect(skillHealth).toMatchObject({ observed: { state: 'available', value: {
                    inventorySha256: digest(JSON.stringify(installedInventory)), inventory: installedInventory, skills: [...new Set(installedInventory.map(row => row.path.split('/').at(-2)!))].sort(),
                    costs: expect.arrayContaining([
                    expect.objectContaining({ target: 'claudecode', metric: 'frontmatter_bytes', value: installedFrontmatterBytes }),
                ]) } } })
                expect(skillHealth).toHaveProperty('observed.value.costs.length', frontmatterByTarget.size)
                expect(skillHealth).toMatchObject({ observed: { value: { costs: expect.arrayContaining(
                    [...frontmatterByTarget].map(([target, value]) => expect.objectContaining({ target, metric: 'frontmatter_bytes', value })),
                ) } } })

                expect(projectWorkApplicationAuthorities({ ...application })).toBeUndefined()
                const projected = projectWorkApplicationAuthorities(application)
                if (!projected) throw new Error('work application authorities were not projected')
                expect(consumeWorkApplicationAuthorities({ ...projected })).toBeUndefined()
                const authorities = consumeWorkApplicationAuthorities(projected)
                if (!authorities) throw new Error('work application authorities were not consumed')
                expect(consumeWorkApplicationAuthorities(projected)).toBeUndefined()
                expect(projectWorkApplicationAuthorities(application)).toBeUndefined()
                expect(authorities.workEnvironment).toMatchObject({
                    cockpitRoot: fixture.root,
                    siblingsRoot: '.',
                    source: { path: fixture.configPath },
                    browser: { project: { lockfile: 'app/package-lock.json', sha256: projectSha256 } },
                })
                expect(authorities.evaluator).toMatchObject({
                    path: resolve('packages/cockpit/surfaces/agents/evaluator.agent.md'),
                    restriction: 'instructed',
                })
                expect(digest(authorities.evaluator.bytes)).toBe(authorities.evaluator.sha256)
                expect(authorities.installedSkills.map(({ path }) => path)).toEqual(expect.arrayContaining([
                    '.agents/skills/cockpit-setup/SKILL.md',
                    '.opencode/skills/cockpit-fix/SKILL.md',
                ]))
                expect(authorities.browser).toMatchObject({
                    mcp: { name: 'playwright', source: { path: 'browser.mcp.json', sha256: digest(await readFile(join(fixture.root, 'browser.mcp.json'))) } },
                    skillTemplate: { path: 'skills/cockpit-browser.skill.md' },
                })
                expect(authorities.testing.registry).toMatchObject({ kind: 'bound', gates: [{ id: 'focused' }] })
                const mcp = JSON.parse(await readFile(join(fixture.root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
                expect(Object.keys(mcp.mcpServers).sort()).toEqual(['unrelated'])
                const codex = parseToml(await readFile(join(fixture.root, '.codex/config.toml'), 'utf8')) as {
                    mcp_servers: Record<string, unknown>
                }
                expect(Object.keys(codex.mcp_servers).sort()).toEqual(['unrelated'])
                expect(/"playwright"\s*:/.test(await readFile(join(fixture.root, 'opencode.jsonc'), 'utf8'))).toBe(false)
                for (const prefix of ['.claude', '.agents', '.opencode']) {
                    await expect(lstat(join(fixture.root, prefix, 'skills/cockpit-browser/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
                }
                expect(await readFile(join(fixture.root, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md')
                expect(await readFile(join(fixture.root, 'AGENTS.md'), 'utf8')).toContain('`focused` (unit)')
                await expect(lstat(join(fixture.root, '.githooks/pre-push'))).rejects.toMatchObject({ code: 'ENOENT' })
                const checked = await checkGeneratedEnvironment({ configPath: fixture.configPath })
                expect(checked, JSON.stringify(checked.diagnostics)).toMatchObject({ kind: 'complete' })
            } finally {
                if (priorHome === undefined) delete process.env.HOME
                else process.env.HOME = priorHome
                if (priorXdgStateHome === undefined) delete process.env.XDG_STATE_HOME
                else process.env.XDG_STATE_HOME = priorXdgStateHome
            }
        })
})
})
