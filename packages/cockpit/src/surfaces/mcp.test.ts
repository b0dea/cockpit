import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, it } from 'vitest'

import { collectMcpDeclarations, mcpApprovalDigest, parseMcpDeclarationFile } from './mcp.js'

const source = { kind: 'sibling', slug: 'service', path: '.mcp.json', sha256: 'a'.repeat(64) } as const
const declaration = {
    name: 'synthetic', command: 'node', args: ['server.mjs'], cwd: '/synthetic/service',
    envNames: ['SYNTHETIC_TOKEN'], source,
}
const targets = ['claudecode', 'codexcli', 'opencode'] as const
const approval = { synthetic: mcpApprovalDigest(declaration, '/synthetic/cockpit') }

it('collects one sibling server disabled across all targets with a named-env wrapper', () => {
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [declaration], approved: {}, targets })
    expect(outcome.kind).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(outcome.result.servers).toHaveLength(1)
    expect(outcome.result.servers[0]).toMatchObject({ name: declaration.name, command: declaration.command, args: declaration.args, cwd: declaration.cwd, envNames: declaration.envNames, enabled: false, sources: [source] })
    expect(outcome.result.harnesses.map(row => row.servers[0]?.enabled)).toEqual([false, false, false])
    expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_NOT_APPROVED', server: 'synthetic' }))
    const wrapper = outcome.result.wrappers[0]!
    expect(wrapper.bytes).toContain('SYNTHETIC_TOKEN="${SYNTHETIC_TOKEN?required environment name SYNTHETIC_TOKEN is unset}"')
    expect(wrapper.bytes).toContain('env -i')
    expect(wrapper.sha256).toBe(createHash('sha256').update(wrapper.bytes).digest('hex'))
    expect(Object.isFrozen(outcome.result.servers[0]?.sources)).toBe(true)
})

it('deduplicates identical declarations and derives approval exactly once', () => {
    const declarations = [declaration, { ...declaration,
        envNames: [...declaration.envNames], source: { ...source, slug: 'other', sha256: 'b'.repeat(64) },
    }]
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations, approved: approval, targets })
    expect(outcome.kind).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(outcome.result.servers).toHaveLength(1)
    expect(outcome.result.servers[0]?.sources).toHaveLength(2)
    expect(outcome.result.harnesses.every(row => row.servers[0]?.enabled === true)).toBe(true)
    expect(collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [...declarations].reverse(), approved: approval, targets })).toEqual(outcome)
})

it('approves a server only at the declaration whose digest was recorded, the same in every clone', () => {
    // A sibling's declaration file is agent-writable; approving the name alone let a rewritten command start.
    expect(mcpApprovalDigest({ ...declaration, cwd: '/another/clone/service' }, '/another/clone/cockpit')).toBe(approval.synthetic)
    for (const difference of [{ command: 'sh' }, { args: ['-c', 'other'] }, { cwd: '/synthetic/other' }, { envNames: ['OTHER_TOKEN'] }]) {
        const changed = { ...declaration, ...difference }
        const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [changed], approved: approval, targets })
        if (outcome.kind !== 'complete') throw new Error(JSON.stringify(outcome))
        expect(outcome.result.harnesses.map(row => row.servers[0]?.enabled), JSON.stringify(difference)).toEqual([false, false, false])
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: 'MCP_NOT_APPROVED', server: 'synthetic',
            sha256: mcpApprovalDigest(changed, '/synthetic/cockpit') })])
    }
    expect(collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [declaration], approved: { synthetic: 'not-a-digest' }, targets }).kind).toBe('refusal')
})

it('keeps case-distinct identities on distinct wrapper paths', () => {
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [declaration, { ...declaration, name: 'Synthetic' }], approved: {}, targets })
    expect(outcome.kind).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(new Set(outcome.result.wrappers.map(row => row.path.toLowerCase())).size).toBe(2)
})

it('launches a wrapper from any clone of the cockpit into its sibling with PATH and only the named environment', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'mcp-wrapper-'))
    try {
        const collect = (parent: string) => collectMcpDeclarations({ cockpitDirectory: join(parent, 'cockpit'),
            declarations: [{ ...declaration, command: 'bin/server', args: [], cwd: join(parent, 'service') }],
            approved: { synthetic: mcpApprovalDigest({ ...declaration, command: 'bin/server', args: [], cwd: join(parent, 'service') }, join(parent, 'cockpit')) }, targets })
        const outcome = collect(workspace)
        expect(outcome.kind).toBe('complete')
        if (outcome.kind !== 'complete') return
        const elsewhere = collect('/another/clone')
        if (elsewhere.kind !== 'complete') throw new Error('expected a second clone to collect')
        // Only these reach committed files; the server model keeps machine paths for this run.
        expect({ wrappers: elsewhere.result.wrappers, harnesses: elsewhere.result.harnesses })
            .toEqual({ wrappers: outcome.result.wrappers, harnesses: outcome.result.harnesses })
        const wrapper = outcome.result.wrappers[0]!
        const root = join(workspace, 'cockpit')
        mkdirSync(join(root, dirname(wrapper.path)), { recursive: true })
        writeFileSync(join(root, wrapper.path), wrapper.bytes, { mode: 0o600 })
        // A `#!/usr/bin/env` server, like `npx`, resolves its interpreter through PATH.
        mkdirSync(join(workspace, 'service/bin'), { recursive: true })
        writeFileSync(join(workspace, 'service/bin/server'), '#!/usr/bin/env sh\npwd -P\nenv | sort\n', { mode: 0o700 })
        const server = outcome.result.harnesses[0]!.servers[0]!
        // CDPATH must not pick a decoy directory and print it into the JSON-RPC stream, and a root
        // reached through a link resolves `..` from its real location, as the relative path was computed.
        mkdirSync(join(workspace, 'decoy/service/bin'), { recursive: true })
        writeFileSync(join(workspace, 'decoy/service/bin/server'), '#!/bin/sh\necho decoy\n', { mode: 0o700 })
        mkdirSync(join(workspace, 'elsewhere'))
        symlinkSync(root, join(workspace, 'elsewhere/cockpit'))
        for (const cwd of [root, join(workspace, 'elsewhere/cockpit')]) {
            // A harness passes on the logical PWD it was started in.
            const child = spawnSync(server.command, [...server.args], { cwd, encoding: 'utf8',
                env: { PATH: '/usr/bin:/bin', HOME: '/synthetic/home', SYNTHETIC_TOKEN: 'synthetic-runtime-value', UNDECLARED: 'excluded', CDPATH: join(workspace, 'decoy'), PWD: cwd } })
            expect(child.stderr, cwd).toBe('')
            expect(child.stdout.split('\n').filter(line => line !== '' && !line.startsWith('PWD=') && !line.startsWith('SHLVL=') && !line.startsWith('_=')), cwd).toEqual([
                realpathSync(join(workspace, 'service')), 'HOME=/synthetic/home', 'PATH=/usr/bin:/bin', 'SYNTHETIC_TOKEN=synthetic-runtime-value',
            ])
        }
        expect(JSON.stringify(outcome)).not.toContain('synthetic-runtime-value')
        // A sibling inside the root is a plain relative name, which CDPATH would otherwise search first.
        const inner = { ...declaration, name: 'inner', command: 'bin/server', args: [], envNames: [], cwd: join(root, 'inner') }
        const nested = collectMcpDeclarations({ cockpitDirectory: root, declarations: [inner], approved: { inner: mcpApprovalDigest(inner, root) }, targets })
        if (nested.kind !== 'complete') throw new Error(JSON.stringify(nested))
        writeFileSync(join(root, nested.result.wrappers[0]!.path), nested.result.wrappers[0]!.bytes, { mode: 0o600 })
        mkdirSync(join(root, 'inner/bin'), { recursive: true })
        writeFileSync(join(root, 'inner/bin/server'), '#!/bin/sh\npwd -P\n', { mode: 0o700 })
        mkdirSync(join(workspace, 'decoy/inner/bin'), { recursive: true })
        writeFileSync(join(workspace, 'decoy/inner/bin/server'), '#!/bin/sh\necho decoy\n', { mode: 0o700 })
        expect(spawnSync('/bin/sh', [nested.result.wrappers[0]!.path], { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', CDPATH: join(workspace, 'decoy') } }))
            .toMatchObject({ status: 0, stdout: `${realpathSync(join(root, 'inner'))}\n`, stderr: '' })
    } finally { rmSync(workspace, { recursive: true, force: true }) }
})

it.each([
    { command: 'other' }, { args: ['other.mjs'] }, { cwd: '/synthetic/other' }, { envNames: ['OTHER_TOKEN'] },
])('refuses divergent same-name commands and names both sources', difference => {
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [declaration, { ...declaration, ...difference,
        source: { ...source, slug: 'other' },
    }], approved: approval, targets })
    expect(outcome).toMatchObject({ kind: 'refusal', diagnostic: { code: 'MCP_COMMAND_CONFLICT', server: 'synthetic', sources: [source, { ...source, slug: 'other' }] } })
})

it('parses standard sibling declarations without carrying environment values', () => {
    const bytes = JSON.stringify({ mcpServers: { synthetic: { command: 'node', args: ['server.mjs'], env: { SYNTHETIC_TOKEN: '${SYNTHETIC_TOKEN}' } } } })
    const parsed = parseMcpDeclarationFile({ bytes, source: { ...source, sha256: createHash('sha256').update(bytes).digest('hex') }, workingDirectory: '/synthetic/service' })
    expect(parsed.kind).toBe('complete')
    if (parsed.kind !== 'complete') return
    expect(parsed.declarations[0]).toMatchObject({ command: 'node', envNames: ['SYNTHETIC_TOKEN'], cwd: '/synthetic/service' })
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: parsed.declarations, approved: {}, targets })
    expect(outcome.kind).toBe('complete')
    expect(JSON.stringify(outcome)).not.toContain('"env":')
})

it('refuses literal credentials, foreign aliases and unsafe commands without disclosing values', () => {
    const canary = 'synthetic-credential-canary'
    for (const server of [
        { command: 'node', env: { SYNTHETIC_TOKEN: canary } },
        { command: 'node', env: { SYNTHETIC_TOKEN: '${OTHER_TOKEN}' } },
        { command: 'node', args: ['--token', canary] },
        { command: 'node$(touch forbidden)', args: [] },
    ]) {
        const bytes = JSON.stringify({ mcpServers: { synthetic: server } })
        const outcome = parseMcpDeclarationFile({ bytes, source: { ...source, sha256: createHash('sha256').update(bytes).digest('hex') }, workingDirectory: '/synthetic/service' })
        expect(outcome.kind).toBe('refusal')
        expect(JSON.stringify(outcome)).not.toContain(canary)
    }
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [{ ...declaration, env: { SYNTHETIC_TOKEN: canary } }], approved: {}, targets })
    expect(outcome.kind).toBe('refusal')
    expect(JSON.stringify(outcome)).not.toContain(canary)
})

it('refuses non-own, oversized and stale-source input before returning servers', () => {
    let reads = 0
    const input = { cockpitDirectory: '/synthetic/cockpit', declarations: [declaration], approved: {}, targets }
    expect(collectMcpDeclarations(new Proxy(input, {})).kind).toBe('refusal')
    const accessor = Object.defineProperty({}, 'declarations', { enumerable: true, get: () => { reads += 1; return [] } })
    expect(collectMcpDeclarations(accessor).kind).toBe('refusal')
    expect(reads).toBe(0)
    expect(collectMcpDeclarations({ ...input, declarations: [{ ...declaration, args: ['x'.repeat(65_537)] }] }).kind).toBe('refusal')
    expect(parseMcpDeclarationFile({ bytes: '{}', source, workingDirectory: '/synthetic/service' }).kind).toBe('refusal')
})
