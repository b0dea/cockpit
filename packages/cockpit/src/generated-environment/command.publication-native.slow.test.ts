import { spawnSync } from 'node:child_process'
import { readFile, rm, stat, writeFile, mkdir, realpath, lstat } from 'node:fs/promises'
import { symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

import { CockpitConfig } from '../schema.js'
import { cockpitId, publicationCockpitId } from '../environment/identity.js'
import { mcpApprovalDigest } from '../surfaces/mcp.js'
import { parseOwnershipManifest } from '../surfaces/ownership.js'
import { HARNESS_REGISTRY, SURFACE_TARGETS } from '../surfaces/harness-registry.js'
import {
    generatedApplicationProjection,
    projectWorkApplicationAuthorities,
    consumeWorkApplicationAuthorities,
} from '../environment/generated-application/authorities.js'
import { observeGeneratedApplicationSurfaces } from '../environment/generated-application/surface-observation.js'
import { staleMcpOutputsOnly } from '../environment/generated-application/surface-outputs.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './command.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'
import { writeSiblingCheckouts } from '../environment/sibling-checkouts.js'
import { stubComposeTopology } from '../../test-support/compose-topology-docker.js'
import { claudeProjectKey } from '../guards/agent-homes.js'

const { roots, cleanup, surfaceConsumer, digest, runGeneratedGuard, bytes } = createGeneratedCommandFixture()
afterEach(cleanup)

describe('generated environment command', () => {
describe('public surface publication transaction', () => {
        it('publishes exact MCP tools and enforces them through the authenticated generated guard', async () => {
            const fixture = await surfaceConsumer('restricted-mcp', { mcp: { command: '/usr/bin/true' } })
            expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
            const config = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            config.mcp.allowed_tools = { 'approved-server': ['read_record'] }
            await writeFile(fixture.configPath, stringifyToml(config))
            await writeFile(join(fixture.siblingDirectory, 'package-lock.json'), '{}')
            await writeFile(join(fixture.siblingDirectory, '.mcp.json'), JSON.stringify({
                mcpServers: { 'approved-server': { command: '/usr/bin/true' } },
            }))
            const result = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(result, JSON.stringify(result.diagnostics)).toMatchObject({ kind: 'complete' })
            const codex = parseToml(await readFile(join(fixture.root, '.codex/config.toml'), 'utf8'))
            expect(codex).toMatchObject({ mcp_servers: { 'approved-server': { enabled_tools: ['read_record'] } } })
            const settings = JSON.parse(await readFile(join(fixture.root, '.claude/settings.json'), 'utf8'))
            expect(settings.permissions.allow.filter((rule: string) => rule.startsWith('mcp__'))).toEqual([])
            const matcher = new RegExp(settings.hooks.PreToolUse[0].matcher)
            for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'mcp__approved-server__read_record', 'mcp__approved-server__new_tool']) expect(matcher.test(tool)).toBe(true)
            // Hold messages name these as continuing, so the matcher must leave them out.
            for (const tool of ['Read', 'mcp__unrestricted__read_record', 'mcp__unrestricted__Write', 'mcp__plugin_reports__read_record', 'mcp__approved-server-extra__read_record']) expect(matcher.test(tool)).toBe(false)
            for (const [tool, expected] of [['read_record', 'allow'], ['write_record', 'deny'], ['execute_tool', 'deny']] as const) {
                const run = spawnSync('/bin/bash', [join(fixture.root, '.cockpit/guards/bash-guard.sh'), '--harness', 'claudecode'], {
                    cwd: fixture.root, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse',
                        tool_name: `mcp__approved-server__${tool}`, cwd: fixture.root, tool_input: { operation: 'read_record' } }),
                })
                expect(run.status, run.stderr).toBe(0)
                expect(run.stdout ? JSON.parse(run.stdout).hookSpecificOutput.permissionDecision : 'allow').toBe(expected)
            }
            config.mcp.allowed_tools['approved-server']!.push('write_record')
            await writeFile(fixture.configPath, stringifyToml(config))
            const stale = spawnSync('/bin/bash', [join(fixture.root, '.cockpit/guards/bash-guard.sh'), '--harness', 'claudecode'], {
                cwd: fixture.root, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse',
                    tool_name: 'mcp__approved-server__write_record', cwd: fixture.root, tool_input: {} }),
            })
            // The widened allowlist is not in force before a person syncs: the call is judged under the
            // synced one, and the refusal says why.
            expect(stale.status, stale.stderr).toBe(0)
            expect(JSON.parse(stale.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny',
                permissionDecisionReason: expect.stringContaining('has an unapproved edit that widens what agents may do') })
        })

        it('admits each agent tool\'s own files through the installed hook from the session the payload names', async () => {
            const fixture = await surfaceConsumer('agent-workspaces')
            expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
            await writeFile(join(fixture.siblingDirectory, 'package-lock.json'), '{}')
            const synced = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete' })
            const root = await realpath(fixture.root)
            const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-home-')))
            roots.push(home)
            const claudeHome = join(home, '.claude')
            const codexHome = join(home, '.codex')
            const project = claudeProjectKey(root)
            const session = { transcript_path: join(claudeHome, 'projects', project, 'session-one.jsonl'), session_id: 'session-one' }
            const guard = (harness: string, call: object) => {
                const run = spawnSync('/bin/bash', [join(root, '.cockpit/guards/bash-guard.sh'), '--harness', harness], {
                    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home },
                    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root, ...call }),
                })
                // A decision the guard cannot reach exits 2 with its reason, which refuses the call.
                if (run.status === 2) return { permissionDecision: 'unavailable', permissionDecisionReason: run.stderr }
                expect(run.status, run.stderr).toBe(0)
                return run.stdout ? JSON.parse(run.stdout).hookSpecificOutput : { permissionDecision: 'allow' }
            }
            const write = (file_path: string, facts: object = session) => guard('claudecode', { ...facts, tool_name: 'Write', tool_input: { file_path, content: 'synthetic' } })
            const scratchpad = join(await realpath('/tmp'), `claude-${process.getuid!()}`, project, 'session-one', 'scratchpad', 'notes.md')
            for (const path of [join(claudeHome, 'projects', project, 'memory', 'MEMORY.md'), join(claudeHome, 'plans', 'bright-plan.md'), scratchpad]) {
                expect(write(path), path).toMatchObject({ permissionDecision: 'allow' })
            }
            expect(write(join(claudeHome, 'settings.json'))).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('a control') })
            expect(write(join(claudeHome, 'projects', '-workspace-other', 'memory', 'MEMORY.md'))).toMatchObject({ permissionDecision: 'deny',
                permissionDecisionReason: expect.stringContaining('another project') })
            // Without the session's facts its scratchpad is no workspace.
            expect(write(scratchpad, {}).permissionDecision).not.toBe('allow')
            // A spelling that leaves a link through `..` lands where the link leads, not in temp.
            const shared = await realpath(await mkdtemp(join(await realpath('/tmp'), 'agent-escape-')))
            roots.push(shared)
            await mkdir(join(shared, 'd'))
            await symlink(home, join(shared, 'd', 'l'))
            const shell = (command: string) => guard('claudecode', { ...session, tool_name: 'Bash', tool_input: { command } })
            expect(shell(`echo x > ${shared}/d/kept.txt`)).toMatchObject({ permissionDecision: 'allow' })
            expect(shell(`echo x > ${shared}/d/l/../escape.txt`).permissionDecision).not.toBe('allow')
            // The agent reads back a spilled tool output, never the login beside it.
            const spilled = join(claudeHome, 'projects', project, 'session-one', 'tool-results', 'out.txt')
            await mkdir(dirname(spilled), { recursive: true })
            await writeFile(spilled, 'synthetic output\n')
            await writeFile(join(claudeHome, '.credentials.json'), '{}')
            const read = (command: string) => guard('claudecode', { ...session, tool_name: 'Bash', tool_input: { command } })
            expect(read(`rg synthetic ${spilled}`)).toMatchObject({ permissionDecision: 'allow' })
            expect(read(`cat ${join(claudeHome, '.credentials.json')}`)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('credential') })
            const notes = join(codexHome, 'memories', 'extensions', 'ad_hoc', 'notes')
            const codex = (command: string) => guard('codexcli', { session_id: 'session-two', tool_name: 'Bash', tool_input: { command },
                transcript_path: join(codexHome, 'sessions', '2026', '11', '13', 'rollout-2026-11-13T08-00-00-session-two.jsonl') })
            expect(codex(`mkdir -p ${notes} && printf x > ${join(notes, 'a.md')}`)).toMatchObject({ permissionDecision: 'allow' })
            expect(codex(`printf x > ${join(codexHome, 'config.toml')}`)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('a control') })
        })

        it('guards a Claude Code session started below the cockpit root through the local registration sync writes', async () => {
            const fixture = await surfaceConsumer('subdirectory-session')
            expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
            await writeFile(join(fixture.siblingDirectory, 'package-lock.json'), '{}')
            const synced = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete' })
            const root = await realpath(fixture.root)
            const settingsDirectory = join(root, '.claude')
            const guardHook = async (file: string) => (JSON.parse(await readFile(join(settingsDirectory, file), 'utf8')) as {
                hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }).hooks.PreToolUse.at(-1)!.hooks[0]!.command
            // The local registration is the committed one, so Claude Code runs it once from the root.
            const command = await guardHook('settings.local.json')
            expect(command).toBe(await guardHook('settings.json'))
            const subdirectory = join(root, 'docs', 'deep')
            await mkdir(subdirectory, { recursive: true })
            const call = (tool_input: object, tool_name = 'Write') => {
                const run = spawnSync('/bin/sh', ['-c', command], { cwd: subdirectory, encoding: 'utf8',
                    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PROJECT_DIR: subdirectory },
                    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, cwd: subdirectory, tool_input }) })
                expect(run.status, run.stderr).toBe(0)
                return run.stdout ? JSON.parse(run.stdout).hookSpecificOutput.permissionDecision : 'allow'
            }
            expect(call({ file_path: join(root, '.cockpit/guards/bash-guard.sh'), content: 'exit 0' })).toBe('deny')
            expect(call({ command: 'git push --force origin main' }, 'Bash')).toBe('deny')
            expect(call({ file_path: join(subdirectory, 'notes.md'), content: 'synthetic' })).toBe('allow')
        })

        it('applies a tool restriction under stale_delete = person, removing only the unchanged MCP file of a tool still listed', async () => {
            const fixture = await surfaceConsumer('stale-mcp', { mcp: { command: '/usr/bin/true' } })
            expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
            const config = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            config.surfaces.tools = ['claudecode', 'codexcli', 'cursor', 'grokcli']
            config.autonomy.stale_delete = 'person'
            await writeFile(fixture.configPath, stringifyToml(config))
            await writeFile(join(fixture.siblingDirectory, 'package-lock.json'), '{}')
            await writeFile(join(fixture.siblingDirectory, '.mcp.json'), JSON.stringify({ mcpServers: { 'approved-server': { command: '/usr/bin/true' } } }))
            const first = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(first, JSON.stringify(first.diagnostics)).toMatchObject({ kind: 'complete' })
            const cursorPath = join(fixture.root, '.cursor/mcp.json')
            const cursorBytes = await readFile(cursorPath, 'utf8')
            expect(cursorBytes).toContain('approved-server')
            expect(await readFile(join(fixture.root, '.grok/config.toml'), 'utf8')).toContain('approved-server')

            config.mcp.allowed_tools = { 'approved-server': ['read_record'] }
            await writeFile(fixture.configPath, stringifyToml(config))
            const codexEnabledTools = async () => (parseToml(await readFile(join(fixture.root, '.codex/config.toml'), 'utf8')) as { mcp_servers: Record<string, { enabled_tools?: unknown }> }).mcp_servers['approved-server']!.enabled_tools

            // A hand edit is not ours to delete, and nothing narrows until it is resolved.
            await writeFile(cursorPath, `${cursorBytes}\n`)
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'SURFACE_STATE_CONFLICT', target: '.cursor/mcp.json' })] })
            expect(await codexEnabledTools()).toBeUndefined()
            expect(await readFile(cursorPath, 'utf8')).toBe(`${cursorBytes}\n`)
            await writeFile(cursorPath, cursorBytes)

            const reported = await checkGeneratedEnvironment({ configPath: fixture.configPath })
            expect(reported).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT', target: '.cursor/mcp.json', fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>' })] })
            const preview = await syncGeneratedEnvironment({ configPath: fixture.configPath, dryRun: true })
            expect(preview).toMatchObject({ kind: 'complete', result: { changes: expect.arrayContaining([{ operation: 'remove', path: '.cursor/mcp.json' }]) } })
            expect(preview.result).not.toHaveProperty('staleRemoval')

            const narrowed = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(narrowed, JSON.stringify(narrowed.diagnostics)).toMatchObject({ kind: 'complete' })
            expect(await codexEnabledTools()).toEqual(['read_record'])
            const settings = JSON.parse(await readFile(join(fixture.root, '.claude/settings.json'), 'utf8'))
            expect(new RegExp(settings.hooks.PreToolUse[0].matcher).test('mcp__approved-server__write_record')).toBe(true)
            await expect(lstat(cursorPath)).rejects.toMatchObject({ code: 'ENOENT' })
            expect(await readFile(join(fixture.root, '.grok/config.toml'), 'utf8')).not.toContain('approved-server')
            expect(await checkGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })

            expect(staleMcpOutputsOnly(['.cursor/mcp.json'], ['claudecode'])).toBe(false)
            expect(staleMcpOutputsOnly(['.grok/config.toml'], ['grokcli'])).toBe(false)
            // Dropping a tool removes more than its MCP file, so that stays a person's approval.
            config.surfaces.tools = ['claudecode', 'codexcli', 'grokcli']
            await writeFile(fixture.configPath, stringifyToml(config))
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_STALE_APPROVAL_REQUIRED' })] })
        })

        it('checks only MCP metadata within a bounded native envelope and retains shell and edit limits', async () => {
            const fixture = await surfaceConsumer('large-mcp', { mcp: { command: '/usr/bin/true' } })
            expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
            const config = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            config.mcp.allowed_tools = { 'approved-server': ['read_record'] }
            await writeFile(fixture.configPath, stringifyToml(config))
            await writeFile(join(fixture.siblingDirectory, 'package-lock.json'), '{}')
            await writeFile(join(fixture.siblingDirectory, '.mcp.json'), JSON.stringify({ mcpServers: { 'approved-server': { command: '/usr/bin/true' } } }))
            const synced = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete' })
            const invoke = (tool: string, tool_input: unknown) => spawnSync('/bin/bash', [join(fixture.root, '.cockpit/guards/bash-guard.sh'), '--harness', 'claudecode'], {
                cwd: fixture.root, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, cwd: fixture.root, tool_input }),
            })
            const allowed = invoke('mcp__approved-server__read_record', { text: 'x'.repeat(131_072) })
            expect(allowed.status, allowed.stderr).toBe(0)
            expect(allowed.stdout).toBe('')
            const denied = invoke('mcp__approved-server__write_record', { text: 'x'.repeat(131_072) })
            expect(denied.status, denied.stderr).toBe(0)
            expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
            const oversized = invoke('mcp__approved-server__read_record', { text: 'x'.repeat(1_048_576) })
            expect(oversized.status).toBe(2)
            expect(oversized.stderr).toContain('byte bound')
            for (const run of [invoke('Bash', { command: 'printf x', description: 'x'.repeat(65_536) }),
                invoke('Write', { file_path: join(fixture.root, 'notes.txt'), content: 'x'.repeat(65_536) })]) {
                expect(run.status).toBe(2)
                expect(run.stderr).toContain('byte bound')
            }
            const malformed = invoke('mcp__approved-server__read_record', [])
            expect(malformed.status).toBe(2)
        })

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
            declaration.guards.secret_paths = ['var/sessions', 'app:tmp/sessions']
            const remoteHeaders = { Authorization: 'Bearer ${SYNTHETIC_TOKEN}', 'X-Workspace': '${SYNTHETIC_WORKSPACE}' }
            declaration.mcp.approved['remote-headers'] = mcpApprovalDigest({ transport: 'http', url: 'https://mcp.example.test/mcp', headers: remoteHeaders, helper: null }, fixture.root)
            declaration.mcp.approved['remote-helper'] = mcpApprovalDigest({ transport: 'http', url: 'https://helper.example.test/mcp', headers: {},
                helper: { command: 'bin/headers', args: ['remote-helper'], cwd: outside } }, fixture.root)
            await writeFile(fixture.configPath, stringifyToml(CockpitConfig.parse(declaration)))
            await writeFile(join(outside, '.mcp.json'), JSON.stringify({ mcpServers: {
                'approved-server': { command: '/usr/bin/printenv', env: { SYNTHETIC_TOKEN: '${SYNTHETIC_TOKEN}' } },
                'unapproved-server': { command: '/usr/bin/true' },
                'remote-headers': { type: 'http', url: 'https://mcp.example.test/mcp', headers: remoteHeaders },
                'remote-helper': { type: 'http', url: 'https://helper.example.test/mcp', headersHelper: 'bin/headers remote-helper' },
            } }))

            const synchronized = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synchronized, JSON.stringify(synchronized.diagnostics)).toMatchObject({ kind: 'complete' })
            const claude = JSON.parse(await readFile(join(fixture.root, '.mcp.json'), 'utf8')) as {
                mcpServers: Record<string, { command: string; args: string[]; headersHelper?: string }>
            }
            const settings = JSON.parse(await readFile(join(fixture.root, '.claude/settings.json'), 'utf8')) as {
                enabledMcpjsonServers: string[]
                disabledMcpjsonServers: string[]
                permissions: { deny?: string[]; allow?: string[] }
            }
            const codex = parseToml(await readFile(join(fixture.root, '.codex/config.toml'), 'utf8')) as {
                mcp_servers: Record<string, { enabled?: boolean; http_headers_helper?: string }>
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
                mcp: Record<string, { enabled: boolean; headers?: Record<string, string> }>
                permission: { external_directory: Record<string, 'allow'>; read: Record<string, 'deny'>; edit: Record<string, 'deny'> }
            }
            expect(Object.keys(claude.mcpServers).sort()).toEqual(['approved-server', 'remote-headers', 'remote-helper', 'unapproved-server'])
            // Each tool gets its own spelling of a remote server's credential, and none gets a literal.
            const helperCommand = claude.mcpServers['remote-helper']!.headersHelper!
            expect(helperCommand).toMatch(/^\/bin\/sh \.cockpit\/mcp\/[a-f0-9]{64}\.headers\.sh$/)
            expect(claude.mcpServers['remote-headers']).toMatchObject({ type: 'http', url: 'https://mcp.example.test/mcp', headers: remoteHeaders })
            expect(codex.mcp_servers['remote-headers']).toEqual({ url: 'https://mcp.example.test/mcp',
                bearer_token_env_var: 'SYNTHETIC_TOKEN', env_http_headers: { 'X-Workspace': 'SYNTHETIC_WORKSPACE' } })
            expect(codex.mcp_servers['remote-helper']).toEqual({ url: 'https://helper.example.test/mcp', http_headers_helper: helperCommand })
            expect(openCode.mcp['remote-headers']).toEqual({ type: 'remote', url: 'https://mcp.example.test/mcp', enabled: true,
                headers: { Authorization: 'Bearer {env:SYNTHETIC_TOKEN}', 'X-Workspace': '{env:SYNTHETIC_WORKSPACE}' } })
            // OpenCode has no headers helper, and neither remote server is spelled for Cursor or Grok Build.
            expect(openCode.mcp).not.toHaveProperty('remote-helper')
            const cursorMcp = await readFile(join(fixture.root, '.cursor/mcp.json'), 'utf8')
            const grokMcp = await readFile(join(fixture.root, '.grok/config.toml'), 'utf8')
            expect([cursorMcp, grokMcp].filter(bytes => bytes.includes('remote-'))).toEqual([])
            expect(synchronized.diagnostics.filter(row => row.code === 'MCP_TRANSPORT_UNAVAILABLE').map(row => row.target)).toEqual(['remote-headers', 'remote-helper'])
            await mkdir(join(outside, 'bin'))
            await writeFile(join(outside, 'bin/headers'), '#!/bin/sh\nprintf \'{"X-Server":"%s"}\' "$1"\n', { mode: 0o700 })
            expect(spawnSync('/bin/sh', ['-c', helperCommand], { cwd: fixture.root, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }))
                .toMatchObject({ status: 0, stdout: '{"X-Server":"remote-helper"}', stderr: '' })
            expect(settings.enabledMcpjsonServers).toEqual(['approved-server', 'remote-headers', 'remote-helper'])
            // Claude Code ignores `disabled` in `.mcp.json`; only this list keeps the server off.
            expect(settings.disabledMcpjsonServers).toEqual(['unapproved-server'])
            expect(synchronized.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'MCP_NOT_APPROVED', target: 'unapproved-server' }))
            expect(claude.mcpServers['approved-server']!.args).toEqual([expect.stringMatching(/^\.cockpit\/mcp\/[a-f0-9]{64}\.sh$/)])
            // Claude's Read, Grep and Glob bypass the guard hook, so the read denial is native: every
            // `.env` and `.env.*` file, every secrets directory, and each declared instance by its clone-independent sibling suffix.
            // A declared secret path is denied to Read and Edit as itself and everything below it.
            expect(settings.permissions.deny!.filter(rule => rule.startsWith('Read('))).toEqual(['Read(//**/.env)', 'Read(//**/.env.*)', 'Read(//**/.secrets/**)', 'Read(//**/app/.env)',
                'Read(//**/app/tmp/sessions)', 'Read(//**/app/tmp/sessions/**)', 'Read(//**/external/.env)', 'Read(/var/sessions)', 'Read(/var/sessions/**)'])
            expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Edit(//**/app/tmp/sessions)', 'Edit(//**/app/tmp/sessions/**)', 'Edit(/var/sessions)', 'Edit(/var/sessions/**)']))
            // The guard judges command text, so the files it depends on are also denied to the tool's own
            // writes: its script, identity and accepted policy, every hook registration, and each
            // repository's Git hooks and configuration, submodules and worktree configuration included,
            // siblings too. cockpit.toml stays writable, since the guard judges whether an edit to it widens.
            const guardFiles = ['Edit(/.cockpit/guards/bash-guard.sh)', 'Edit(/.cockpit/local/**)', 'Edit(/.cockpit/policy.json)',
                'Edit(/.claude/settings.json)', 'Edit(/.claude/settings.local.json)', 'Edit(/.codex/hooks.json)', 'Edit(/.codex/config.toml)',
                'Edit(/opencode.jsonc)', 'Edit(/.opencode/plugin/**)', 'Edit(//**/.git/hooks/**)', 'Edit(//**/.git/config)',
                'Edit(//**/.git/config.worktree)', 'Edit(//**/.git/**/config.worktree)', 'Edit(//**/.git/modules/**/hooks/**)', 'Edit(//**/.git/modules/**/config)']
            expect(settings.permissions.deny).toEqual(expect.arrayContaining(guardFiles))
            expect(settings.permissions.deny!.filter(rule => rule.includes('cockpit.toml'))).toEqual([])
            // Claude Code's sandbox turns these rules into filesystem write denials, and one naming .git
            // itself, a gitdir or a commondir broke every Git write or git worktree add, so only OpenCode,
            // whose denial binds its edit tool alone, denies the files that locate a repository.
            expect(settings.permissions.deny!.filter(rule => /\/\.git\)$|gitdir|commondir/.test(rule))).toEqual([])
            expect(Object.keys(openCode.permission.edit)).toEqual(expect.arrayContaining(['.cockpit/guards/bash-guard.sh', '*/.cockpit/guards/bash-guard.sh',
                '.cockpit/local/*', 'opencode.jsonc', '.opencode/plugin/*', '.git/hooks/*', '*/.git/hooks/*', '.git/config', '*/.git/config',
                '.git/config.worktree', '*/.git/*/config.worktree', '*/.git/modules/*/hooks/*', '*/.git/modules/*/config', '.git', '*/.git', '*/.git/*/gitdir', '*/.git/*/commondir']))
            expect(Object.values(openCode.permission.edit).every(action => action === 'deny')).toBe(true)
            expect(Object.keys(openCode.permission.edit).filter(pattern => pattern.includes('cockpit.toml'))).toEqual([])
            // A tool gets a write denial exactly where a dated run showed it enforce one; an unmeasured spelling is not written.
            const guardScriptDenied = {
                claudecode: settings.permissions.deny!.includes('Edit(/.cockpit/guards/bash-guard.sh)'),
                codexcli: JSON.stringify(codex).includes('bash-guard.sh'),
                opencode: openCode.permission.edit['.cockpit/guards/bash-guard.sh'] === 'deny',
                cursor: cursorGrant.includes('bash-guard.sh'),
                grokcli: grokGrant.includes('bash-guard.sh'),
            }
            expect(guardScriptDenied).toEqual(Object.fromEntries(HARNESS_REGISTRY.map(row => [row.target, row.guardFiles.fileTools.state === 'enforced'])))
            // Claude's default mode runs no Bash without a rule, so the commands the skills tell an
            // agent to run are allowed by prefix. A policy-decided command such as sync or work accept is
            // allowed too, because the guard's ask still wins; always-person ones keep prompting. down keeps
            // the data volumes, so it is the agent's.
            expect(settings.permissions.allow).toEqual(expect.arrayContaining([
                'Bash(npx --no cockpit test-run *)', 'Bash(./node_modules/.bin/cockpit check *)', 'Bash(npx --no cockpit sync *)',
                'Bash(npx --no cockpit work accept *)', 'Bash(npx --no cockpit reset * --apply)', 'Bash(npx --no cockpit stacks *)', 'Bash(npx --no cockpit env keys *)', 'Bash(npx --no cockpit env schema *)', 'Bash(npx --no cockpit down *)',
            ]))
            expect(settings.permissions.allow!.filter(rule => /cockpit (init|sibling|session)\b/.test(rule))).toEqual([])
            expect(Object.keys(codex.mcp_servers).sort()).toEqual(['approved-server', 'remote-headers', 'remote-helper', 'unapproved-server'])
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
                'approved-server': true, 'remote-headers': true, 'unapproved-server': false,
            })
            expect(openCode.permission.external_directory).toEqual({
                '{file:.cockpit/local/opencode-grant-app}/**': 'allow',
                '{file:.cockpit/local/opencode-grant-external}/**': 'allow',
            })
            // OpenCode reads the absolute directory from the machine-local file the pattern names.
            expect(await readFile(join(fixture.root, '.cockpit/local/opencode-grant-external'), 'utf8')).toBe(await realpath(fixture.siblingDirectory))
            // A checkout `use` serves from outside the declared one keeps its grant through a later sync;
            // one inside the declared checkout is already covered by the declared grant.
            const served = join(estate, 'external-feature')
            expect(await writeSiblingCheckouts(fixture.root, { app: join(fixture.root, 'app/.worktrees/feature'), external: served })).toEqual({ kind: 'complete' })
            expect(await syncGeneratedEnvironment({ configPath: fixture.configPath })).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(fixture.root, '.cockpit/local/opencode-grant-external'), 'utf8')).toBe(served)
            expect(await readFile(join(fixture.root, '.cockpit/local/opencode-grant-app'), 'utf8')).toBe(await realpath(join(fixture.root, 'app')))
            // OpenCode's native read is denied the same paths; its patterns are worktree-relative and
            // its `*` crosses directories. OpenCode adds the exact `$schema` value when it is missing,
            // which once made every later check report a conflict, so cockpit writes it itself.
            expect(openCode.permission.read).toEqual({
                '*/.secrets/*': 'deny', '*/app/.env': 'deny', '*/external/.env': 'deny',
                '.secrets/*': 'deny', 'app/.env': 'deny', 'external/.env': 'deny',
                ...Object.fromEntries(['var/sessions', 'app/tmp/sessions'].flatMap(path => [path, `${path}/*`, `*/${path}`, `*/${path}/*`]).map(pattern => [pattern, 'deny'])),
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
            // A documentation name, so the roots decide rather than the environment-file denial.
            expect(runGeneratedGuard(fixture.root, join(fixture.root, '..', 'unlisted', '.env.example'))).toMatchObject({
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
            await writeFile(join(fixture.root, 'caf\u00e9.example'), 'SYNTHETIC_TOKEN=\n')
            expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
            await writeFile(join(fixture.root, 'app/package-lock.json'), '{}\n')
            const declaration = CockpitConfig.parse(parseToml(await readFile(fixture.configPath, 'utf8')))
            declaration.cockpit.siblings_root = estate
            // No sibling is mounted, so no tool gets a directory grant; the native denials do not wait for one.
            Object.assign(declaration.sibling.find(sibling => sibling.slug === 'app')!, { dir: relative(estate, join(fixture.root, 'app')), mount: 'none' })
            // A host-mounted sibling has no directory grant, and the root sibling is the cockpit checkout itself.
            declaration.sibling.push(CockpitConfig.shape.sibling.element.parse({ slug: 'hosted', dir: 'hosted', mount: 'host', host_reason: 'Synthetic host-only service', gate: 'operator', acquire: 'none',
                var: 'HOSTED_DIR', purpose: 'Synthetic host-mounted service', environment_files: [{ template: '.env.example', instance: '.env' }] }))
            declaration.sibling.push(CockpitConfig.shape.sibling.element.parse({ slug: 'self', dir: relative(estate, fixture.root), mount: 'none', acquire: 'none',
                var: 'SELF_DIR', purpose: 'The cockpit checkout itself', environment_files: [{ template: 'local[1].env.example', instance: 'local[1].env' }, { template: 'caf\u00e9.example', instance: 'caf\u00e9.conf' }] }))
            await writeFile(fixture.configPath, stringifyToml(CockpitConfig.parse(declaration)))

            const synchronized = await syncGeneratedEnvironment({ configPath: fixture.configPath })
            expect(synchronized, JSON.stringify(synchronized.diagnostics)).toMatchObject({ kind: 'complete' })
            const settings = JSON.parse(await readFile(join(fixture.root, '.claude/settings.json'), 'utf8')) as { permissions: { deny?: string[] } }
            // `/` anchors a rule at the project root; measured on Claude Code 2.1.314, 2026-10-30, with an unruled control beside it.
            // A non-ASCII name is denied under both Unicode normal forms, which Claude Code compares literally.
            expect(settings.permissions.deny!.filter(rule => rule.startsWith('Read('))).toEqual(['Read(//**/.env)', 'Read(//**/.env.*)', 'Read(//**/.secrets/**)', 'Read(//**/app/.env)', 'Read(//**/hosted/.env)',
                'Read(/cafe\u0301.conf)', 'Read(/caf\u00e9.conf)', 'Read(/local?1?.env)'])
            expect(settings.permissions.deny).toContain('Edit(/.cockpit/guards/bash-guard.sh)')
            const openCode = JSON.parse((await readFile(join(fixture.root, 'opencode.jsonc'), 'utf8')).replace(/\/\* cockpit:owner:[^*]+ \*\//g, '')) as {
                permission: { external_directory: Record<string, 'allow'>; read: Record<string, 'deny'>; edit: Record<string, 'deny'> }
            }
            expect(openCode.permission.external_directory).toEqual({})
            expect(openCode.permission.read).toMatchObject({ '.secrets/*': 'deny', 'app/.env': 'deny', 'hosted/.env': 'deny' })
            expect(openCode.permission.edit).toMatchObject({ '.cockpit/guards/bash-guard.sh': 'deny', '*/.git/hooks/*': 'deny' })
        })

        // Without a declared endpoint the browser is a local launch: no playwright MCP server or
        // browser skill is published, and the work authorities still carry the project. With a
        // loopback endpoint that one Compose service publishes, both are published.
        it.each([
            { name: 'a nested configuration', layout: 'nested', preapproved: true, serialized: false, openCode: true, endpoint: false },
            { name: 'a linked worktree without preapproval', layout: 'worktree', preapproved: false, serialized: true, openCode: false, endpoint: false },
            { name: 'a standalone directory', layout: 'standalone', preapproved: true, serialized: false, openCode: true, endpoint: false },
            { name: 'a standalone directory with a loopback endpoint', layout: 'standalone', preapproved: true, serialized: false, openCode: true, endpoint: true },
            { name: 'a restricted browser server', layout: 'standalone', preapproved: true, serialized: false, openCode: true, endpoint: true, restricted: true },
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
${variant.endpoint ? 'compose_files = ["compose.yml"]\n' : ''}
`
            if (variant.endpoint) await writeFile(join(fixture.root, 'compose.yml'), [
                'services:', '  browser:', `    image: node@sha256:${'8'.repeat(64)}`,
                '    ports: ["127.0.0.1:${BROWSER_PORT}:3001"]',
                '    volumes: ["${APP_DIR}:/workspace/app", "./.browser/mcp:/browser/mcp", "./.browser/cli:/browser/cli", "./.browser/auth:/browser/auth"]', ''].join('\n'))
            // Compose reports that file's variable source as written and its artifact binds under the project directory.
            if (variant.endpoint) await stubComposeTopology({ browser: { image: `node@sha256:${'8'.repeat(64)}`, ports: ['127.0.0.1:${BROWSER_PORT}:3001'], volumes: [
                { type: 'volume', source: '${APP_DIR}', target: '/workspace/app' },
                ...['mcp', 'cli', 'auth'].map(name => ({ type: 'bind', source: join(fixture.root, '.browser', name), target: `/browser/${name}` })),
            ] } })
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
${variant.restricted ? '\n[mcp.allowed_tools]\nplaywright = ["browser_snapshot"]\n' : ''}

[browser]
engine = "chromium"
harnesses = [{ target = "claudecode", version = "2.1.220" }, { target = "codexcli", version = "0.149.0" }${variant.openCode ? ', { target = "opencode", version = "1.18.15" }' : ''}]
images = { mcp = { reference = ${JSON.stringify(mcpImage)}, driver_version = "1.2.3" } }
project = { manifest = "app/package.json", manifest_sha256 = ${JSON.stringify(digest(manifestBytes))}, lockfile = "app/package-lock.json", sha256 = ${JSON.stringify(projectSha256)}, driver_version = "1.2.3" }
max_clients = 4
${variant.endpoint ? 'endpoint = "ws://localhost:3001/"\n' : ''}proxy = { host_variable = "BROWSER_PORT", server_port = 3000, proxy_port = 3001, allowed_hosts = ["localhost:3001"] }
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
                // A declared browser makes check read the state root, so a sandbox hiding it must read
                // as a state problem: that is the code the setup procedure tells an agent to act on.
                const notADirectory = join(stateHome, 'not-a-directory')
                await writeFile(notADirectory, '')
                process.env.HOME = notADirectory
                process.env.XDG_STATE_HOME = notADirectory
                const hidden = await checkGeneratedEnvironment({ configPath: fixture.configPath })
                expect(hidden.diagnostics, JSON.stringify(hidden.diagnostics)).toEqual(expect.arrayContaining(
                    [expect.objectContaining({ code: 'STATE_ROOT_UNAVAILABLE', message: expect.stringContaining(`${notADirectory} is not a directory`) })]))
                process.env.HOME = stateHome
                process.env.XDG_STATE_HOME = join(stateHome, 'state')
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
                expect(Object.keys(mcp.mcpServers).sort()).toEqual(variant.endpoint ? ['playwright', 'unrelated'] : ['unrelated'])
                const codex = parseToml(await readFile(join(fixture.root, '.codex/config.toml'), 'utf8')) as {
                    mcp_servers: Record<string, unknown>
                }
                expect(Object.keys(codex.mcp_servers).sort()).toEqual(variant.endpoint ? ['playwright', 'unrelated'] : ['unrelated'])
                if (variant.restricted) expect(codex.mcp_servers.playwright).toMatchObject({ enabled_tools: ['browser_snapshot'] })
                // Claude Code offers the evaluator subagent file reads and exactly the browser tools it may call here; the other tools get no such list.
                const browserTools = !variant.endpoint ? [] : variant.restricted ? ['mcp__playwright__browser_snapshot'] : ['mcp__playwright']
                expect(await readFile(join(fixture.root, '.claude/agents/evaluator.md'), 'utf8'))
                    .toContain(`\ntools:\n${['Read', 'Grep', 'Glob', ...browserTools].map(tool => `  - ${tool}\n`).join('')}disallowedTools:`)
                for (const path of ['.codex/agents/evaluator.toml', '.opencode/agents/evaluator.md']) expect(await readFile(join(fixture.root, path), 'utf8')).not.toContain('Glob')
                expect(/"playwright"\s*:/.test(await readFile(join(fixture.root, 'opencode.jsonc'), 'utf8'))).toBe(variant.endpoint && !variant.restricted)
                for (const prefix of ['.claude', '.agents', '.opencode']) {
                    const skill = expect(lstat(join(fixture.root, prefix, 'skills/cockpit-browser/SKILL.md')))
                    if (variant.endpoint && !(variant.restricted && prefix === '.opencode')) await skill.resolves.toBeDefined()
                    else await skill.rejects.toMatchObject({ code: 'ENOENT' })
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
