import { spawnSync } from 'node:child_process'
import { readFile, stat, writeFile, mkdir, realpath, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'

import { loadCockpitConfig } from '../config/load.js'
import { CockpitConfig } from '../schema.js'
import type { HolderId } from '../environment/contract.js'
import { checkoutId, cockpitId, publicationCockpitId, stackId } from '../environment/identity.js'
import { deriveEntrypoints, projectPortLeaseResult } from '../environment/ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { parseOwnershipManifest } from '../surfaces/ownership.js'
import { selectStateRoot, transactState } from '../environment/state.js'
import { recordLifecycleStarted } from '../environment/lifecycle-stage.js'
import {
    generatedApplicationProjection,
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
                rules: true, mcp: true, siblingDirectory: outside, parentDirectory: estate,
            })
            expect(dirname(fixture.root)).toBe(estate)
            expect(dirname(outside)).toBe(estate)
            expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
            await writeFile(join(fixture.root, 'app/package-lock.json'), '{}\n')
            const declaration = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            declaration.cockpit.siblings_root = estate
            declaration.sibling.find(sibling => sibling.slug === 'app')!.dir = relative(estate, join(fixture.root, 'app'))
            // Vendor templates require cockpit-relative output paths.
            declaration.environment.generated!.vendors = []
            declaration.environment.generated!.decisions.entries = declaration.environment.generated!.decisions.entries
                .filter(entry => entry.subject !== 'vendor')
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
                mcp: Record<string, { enabled: boolean }>
                permission: { external_directory: Record<string, 'allow'> }
            }
            expect(Object.keys(claude.mcpServers).sort()).toEqual(['approved-server', 'unapproved-server'])
            expect(settings.enabledMcpjsonServers).toEqual(['approved-server'])
            expect(Object.keys(codex.mcp_servers).sort()).toEqual(['approved-server', 'unapproved-server'])
            expect([codex.mcp_servers['approved-server']?.enabled !== false, codex.mcp_servers['unapproved-server']?.enabled]).toEqual([true, false])
            expect(codex).toMatchObject({
                sandbox_mode: 'workspace-write',
                sandbox_workspace_write: { writable_roots: ['../external', 'app'] },
            })
            expect(codex).not.toHaveProperty('default_permissions')
            expect(codex).not.toHaveProperty('permissions')
            expect(Object.fromEntries(Object.entries(openCode.mcp).map(([name, server]) => [name, server.enabled]))).toEqual({
                'approved-server': true, 'unapproved-server': false,
            })
            expect(openCode.permission.external_directory).toEqual({
                '../external/**': 'allow',
                'app/**': 'allow',
            })
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
            expect((await stat(wrapper)).mode & 0o111).toBe(0)
            const launched = spawnSync(approved.command, approved.args, {
                cwd: fixture.root, env: { SYNTHETIC_TOKEN: 'named-value', UNDECLARED: 'excluded' }, encoding: 'utf8',
            })
            expect(launched).toMatchObject({ status: 0, stdout: 'SYNTHETIC_TOKEN=named-value\n' })
            expect(launched.stdout).not.toContain('UNDECLARED')

            const denied = runGeneratedGuard(fixture.root, join(outside, '.env'))
            expect(denied.stdout, JSON.stringify(denied)).toContain('permissionDecision":"deny')
            expect(runGeneratedGuard(fixture.root, join(outside, '.env.example'))).toMatchObject({ status: 0, stdout: '' })
            expect(runGeneratedGuard(fixture.root, join(fixture.root, '..', 'unlisted', '.env'))).toMatchObject({
                status: 2, stderr: expect.stringContaining('Guard path escapes configured roots.'),
            })
        })

        it.each([
            { name: 'preapproved remote in a nested configuration', layout: 'nested', remote: true, preapproved: true, serialized: false, openCode: true },
            { name: 'remote without preapproval in a linked worktree', layout: 'worktree', remote: true, preapproved: false, serialized: true, openCode: false },
            { name: 'local fallback in a standalone directory', layout: 'standalone', remote: false, preapproved: true, serialized: false, openCode: true },
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
            const runnerImage = `synthetic.invalid/browser-runner@sha256:${'a'.repeat(64)}`
            const mcpImage = `synthetic.invalid/browser-mcp@sha256:${'b'.repeat(64)}`
            const artifactPaths = ['.browser/runner', '.browser/mcp', '.browser/cli', '.browser/auth', '.browser/debugger']
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
mcp_sources = [{ path = "browser.mcp.json", format = "mcp-json", provenance = { source = "synthetic declaration", observed_on = "2026-10-23", kind = "declared", reason = "Synthetic browser transport" } }]

[mcp]
approved = ["playwright"]

[browser]
engine = "${variant.remote ? 'firefox' : 'chromium'}"
harnesses = [{ target = "claudecode", version = "2.1.220" }, { target = "codexcli", version = "0.149.0" }${variant.openCode ? ', { target = "opencode", version = "1.18.15" }' : ''}]
images = { runner = { architectures = ["arm64"], reference = ${JSON.stringify(runnerImage)}, driver_version = "1.2.3" }, mcp = { reference = ${JSON.stringify(mcpImage)}, driver_version = "1.2.3" } }
runner_health_measurement = { duration_seconds = 15, provenance = { source = "synthetic-browser.toml", observed_on = "2026-10-24", kind = "measured", reason = "Synthetic browser readiness measurement" } }
project = { manifest = "app/package.json", manifest_sha256 = ${JSON.stringify(digest(manifestBytes))}, lockfile = "app/package-lock.json", sha256 = ${JSON.stringify(projectSha256)}, driver_version = "1.2.3" }
endpoint = "ws://localhost:3001/"
max_clients = 4
proxy = { host_variable = "BROWSER_PORT", server_port = 3000, proxy_port = 3001, allowed_hosts = ["localhost:3001"] }
resolver = [{ hostname = "app.example.invalid", address = "127.0.0.1" }]
authentication = ${variant.serialized ? '{ policy = "serialized", states = [{ worker = "shared", path = ".browser/auth/shared.json", source = "seeded" }] }' : '{ policy = "none", states = [] }'}
data = { mode = "empty", isolated = true, reaches_production = false }
request_preapproval = true
headed = true
artifacts = { runner = ".browser/runner", mcp = ".browser/mcp", cli = ".browser/cli", auth = ".browser/auth", debugger = ".browser/debugger" }

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
            await writeFile(fixture.configPath, declaration.replace('APP_HOST_PORT = 4100', 'APP_HOST_PORT = 4100\nBROWSER_PORT = 3001')
                .replace('[environment.generated]', `${environment}[environment.generated]`)
                + (variant.remote ? browserDeclaration : browserDeclaration.replace('endpoint = "ws://localhost:3001/"\n', '')))
            const stateHome = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-testing-state-')))
            roots.push(stateHome)
            const priorHome = process.env.HOME
            const priorXdgStateHome = process.env.XDG_STATE_HOME
            process.env.HOME = stateHome
            process.env.XDG_STATE_HOME = join(stateHome, 'state')
            try {
                const currentCockpit = cockpitId({ name: 'generated-environment', mainCheckoutPath: mainCheckout })
                const currentCheckout = checkoutId({ checkoutPath: currentCheckoutPath })
                const currentStack = stackId({ cockpitId: currentCockpit, checkoutId: currentCheckout, variant: { kind: 'shared' } })
                if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('browser port platform unavailable')
                const namespace = await selectStateRoot({ platform: process.platform, home: process.env.HOME,
                    xdgStateHome: process.env.XDG_STATE_HOME, checkoutRoots: [mainCheckout, currentCheckoutPath], cockpitId: currentCockpit })
                if (namespace.kind !== 'complete') throw new Error('browser port state unavailable')
                const currentHolder = `holder:${'c'.repeat(64)}:session` as HolderId
                const observedAt = new Date().toISOString()
                const loadedBrowser = await loadCockpitConfig(fixture.configPath)
                if (loadedBrowser.kind !== 'complete') throw new Error('browser port declaration unavailable')
                const family = loadedBrowser.result.config.ports
                const lease = await leasePortFamilyFixture({ namespace: namespace.value, stackId: currentStack, holderId: currentHolder,
                    checkoutId: currentCheckout, config: family, now: observedAt, listenerTimeoutMs: 1_000,
                    listenerEvidence: Array.from({ length: family.count }, (_, index) => ({
                        ports: Object.values(family.bases).map(base => base + index * family.step),
                        observation: { state: 'available' as const, value: index === 0 ? [family.bases.APP_HOST_PORT!] : [], observedAt, producer: 'browser-publication-control' },
                    })) })
                if (lease.kind !== 'complete') throw new Error('browser port lease unavailable')
                expect(lease.lease.offset).toBeGreaterThan(0)
                const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
                if (entrypoints.kind !== 'complete') throw new Error('browser entrypoint authority unavailable')
                const ports = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
                if (!ports) throw new Error('browser port projection unavailable')
                const started = await recordLifecycleStarted({ namespace: namespace.value, stackId: currentStack,
                    holderId: currentHolder, observedAt })
                if (started.kind === 'refusal') throw new Error('browser lifecycle history unavailable')
                const lifecycleAddress = namespace.value.paths.lifecycle(currentStack)
                const lifecycle = await transactState(namespace.value, lifecycleAddress, { ownerId: currentHolder }, () => ({
                    format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: currentCockpit, subjectId: currentStack,
                    revision: 0, updatedAt: observedAt, value: { holderId: currentHolder,
                        workBasisSha256: 'd'.repeat(64), operationGeneration: 'e'.repeat(64), completedServices: [] },
                }))
                if (lifecycle.kind !== 'complete') throw new Error('browser lifecycle authority unavailable')
                const synchronized = await syncGeneratedEnvironment({ configPath: fixture.configPath }, {}, ports)
                expect(synchronized, JSON.stringify(synchronized.diagnostics)).toMatchObject({ kind: 'complete' })
                if (synchronized.kind !== 'complete') throw new Error('browser and testing surfaces were not synchronized')
                const compose = parseYaml(await readFile(join(fixture.root, 'compose.generated.yml'), 'utf8'))
                if (variant.remote) {
                    const runner = compose.services['cockpit-browser-runner']
                    expect(runner).toMatchObject({ extra_hosts: { 'app.example.invalid': '127.0.0.1' } })
                    expect(runner.command[runner.command.indexOf('--max-clients') + 1]).toBe(variant.serialized ? '1' : '4')
                    expect(runner.command.slice(0, 3)).toEqual(['/bin/sh', '/cockpit/browser-runner.sh', 'serve'])
                    expect(runner.healthcheck.test).toEqual(['CMD-SHELL', "'/bin/sh' '/cockpit/browser-runner.sh' 'check' 'localhost:3001' '3001'"])
                    expect(runner.command).toContain('localhost:3001')
                    expect(runner.command).toContain('localhost:${BROWSER_PORT:-3001}')
                    const runnerPath = join(fixture.root, '.cockpit/browser/runner.sh')
                    expect((await stat(runnerPath)).mode & 0o777).toBe(0o600)
                    const launch = runner.command.slice(0, runner.command.indexOf('serve'))
                        .map((value: string) => value === '/cockpit/browser-runner.sh' ? runnerPath : value)
                    const checked = spawnSync(launch[0], [...launch.slice(1), 'invalid'], { encoding: 'utf8', timeout: 5_000 })
                    expect(checked.error).toBeUndefined()
                    expect(checked.status).toBe(2)
                    expect(checked.stderr).toBe('browser runner operation is invalid\n')
                } else expect(compose.services).not.toHaveProperty('cockpit-browser-runner')
                const application = generatedApplicationProjection(synchronized.result.application)
                if (!application) throw new Error('generated application projection was not issued')
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
                    ...(variant.remote ? ['.claude/skills/cockpit-browser/SKILL.md'] : []),
                    '.opencode/skills/cockpit-fix/SKILL.md',
                ]))
                expect(authorities.browser).toMatchObject({
                    mcp: { name: 'playwright', source: { path: 'browser.mcp.json', sha256: digest(await readFile(join(fixture.root, 'browser.mcp.json'))) } },
                    skillTemplate: { path: 'skills/cockpit-browser.skill.md' },
                })
                if (variant.remote) {
                    const preparation = authorities.browser?.runner?.debugger
                    expect(preparation?.argv[(preparation?.argv.indexOf('--max-clients') ?? -1) + 1]).toBe(variant.serialized ? '1' : '4')
                    expect(preparation?.argv.slice(0, 3)).toEqual(['/bin/sh', join(fixture.root, '.cockpit/browser/runner.sh'), 'debugger'])
                    expect(preparation?.launcher.path).toBe(join(fixture.root, '.cockpit/browser/runner.sh'))
                    const endpoint = `ws://localhost:${lease.lease.ports.BROWSER_PORT}/`
                    expect(authorities.browser!.mcp.args).toEqual(['run', '--rm', '-i', mcpImage, '--endpoint', endpoint])
                    expect(authorities.browser!.mcp.args).toContain(endpoint)
                    expect(authorities.browser!.mcp.args).not.toContain('ws://localhost:3001/')
                    const wrapper = `.cockpit/mcp/${digest('playwright')}.sh`
                    const wrapperBytes = await readFile(join(fixture.root, wrapper), 'utf8')
                    expect(wrapperBytes).toContain(`'${endpoint}'`)
                    expect(wrapperBytes).not.toContain("'ws://localhost:3001/'")
                    const ownership = JSON.parse(await readFile(join(fixture.root, '.cockpit/generated-environment-ownership.json'), 'utf8')) as {
                        entries: { path: string; harnesses: string[] }[]
                    }
                    expect(ownership.entries.find(row => row.path === wrapper)?.harnesses).toEqual([
                        'claudecode',
                        ...(variant.preapproved ? ['codexcli'] : []),
                        ...(variant.openCode ? ['opencode'] : []),
                    ])
                }
                expect(authorities.testing.registry).toMatchObject({ kind: 'bound', gates: [{ id: 'focused' }] })
                const mcp = JSON.parse(await readFile(join(fixture.root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
                expect(Object.keys(mcp.mcpServers).sort()).toEqual(variant.remote ? ['playwright', 'unrelated'] : ['unrelated'])
                if (variant.remote) expect(mcp.mcpServers.playwright).toMatchObject({ command: '/bin/sh' })
                const codex = parseToml(await readFile(join(fixture.root, '.codex/config.toml'), 'utf8')) as {
                    mcp_servers: Record<string, unknown>
                }
                expect(Object.keys(codex.mcp_servers).sort()).toEqual(variant.remote && variant.preapproved
                    ? ['playwright', 'unrelated'] : ['unrelated'])
                expect(/"playwright"\s*:/.test(await readFile(join(fixture.root, 'opencode.jsonc'), 'utf8'))).toBe(variant.remote && variant.openCode)
                // The shipped reference carries a docs-verification marker that is stripped from consumer output.
                const browserReference = (await readFile(resolve('packages/cockpit/surfaces/references/browser.md'), 'utf8'))
                    .replace(/^<!-- cockpit:verified version=\S+ -->\n\n/m, '')
                expect(browserReference).not.toContain('cockpit:verified')
                for (const prefix of ['.claude', '.agents', '.opencode']) {
                    const path = join(fixture.root, prefix, 'skills/cockpit-browser/references/browser.md')
                    if (variant.remote && (prefix === '.claude' || prefix === '.agents' && variant.preapproved
                        || prefix === '.opencode' && variant.openCode)) expect(await readFile(path, 'utf8')).toBe(browserReference)
                    else await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
                }
                if (variant.remote) expect(await readFile(join(fixture.root, '.claude/skills/cockpit-browser/SKILL.md'), 'utf8')).toContain('name: cockpit-browser')
                else await expect(lstat(join(fixture.root, '.claude/skills/cockpit-browser/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
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
