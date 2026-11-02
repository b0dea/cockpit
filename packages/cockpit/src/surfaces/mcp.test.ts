import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, it } from 'vitest'

import { collectMcpDeclarations, parseMcpDeclarationFile } from './mcp.js'

const source = { kind: 'sibling', slug: 'service', path: '.mcp.json', sha256: 'a'.repeat(64) } as const
const declaration = {
    name: 'synthetic', command: 'node', args: ['server.mjs'], cwd: '/synthetic/service',
    envNames: ['SYNTHETIC_TOKEN'], source,
}
const targets = ['claudecode', 'codexcli', 'opencode'] as const

it('collects one sibling server disabled across all targets with a named-env wrapper', () => {
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [declaration], approved: [], targets })
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
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations, approved: ['synthetic'], targets })
    expect(outcome.kind).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(outcome.result.servers).toHaveLength(1)
    expect(outcome.result.servers[0]?.sources).toHaveLength(2)
    expect(outcome.result.harnesses.every(row => row.servers[0]?.enabled === true)).toBe(true)
    expect(collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [...declarations].reverse(), approved: ['synthetic'], targets })).toEqual(outcome)
})

it('keeps case-distinct identities on distinct wrapper paths', () => {
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [declaration, { ...declaration, name: 'Synthetic' }], approved: [], targets })
    expect(outcome.kind).toBe('complete')
    if (outcome.kind !== 'complete') return
    expect(new Set(outcome.result.wrappers.map(row => row.path.toLowerCase())).size).toBe(2)
})

it('launches a wrapper from any clone of the cockpit into its sibling with PATH and only the named environment', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'mcp-wrapper-'))
    try {
        const collect = (parent: string) => collectMcpDeclarations({ cockpitDirectory: join(parent, 'cockpit'),
            declarations: [{ ...declaration, command: 'bin/server', args: [], cwd: join(parent, 'service') }], approved: ['synthetic'], targets })
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
        const child = spawnSync(server.command, [...server.args], { cwd: root, encoding: 'utf8',
            env: { PATH: '/usr/bin:/bin', HOME: '/synthetic/home', SYNTHETIC_TOKEN: 'synthetic-runtime-value', UNDECLARED: 'excluded' } })
        expect(child.stderr).toBe('')
        expect(child.stdout.split('\n').filter(line => line !== '' && !line.startsWith('PWD=') && !line.startsWith('SHLVL=') && !line.startsWith('_='))).toEqual([
            realpathSync(join(workspace, 'service')), 'HOME=/synthetic/home', 'PATH=/usr/bin:/bin', 'SYNTHETIC_TOKEN=synthetic-runtime-value',
        ])
        expect(JSON.stringify(outcome)).not.toContain('synthetic-runtime-value')
    } finally { rmSync(workspace, { recursive: true, force: true }) }
})

it.each([
    { command: 'other' }, { args: ['other.mjs'] }, { cwd: '/synthetic/other' }, { envNames: ['OTHER_TOKEN'] },
])('refuses divergent same-name commands and names both sources', difference => {
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [declaration, { ...declaration, ...difference,
        source: { ...source, slug: 'other' },
    }], approved: ['synthetic'], targets })
    expect(outcome).toMatchObject({ kind: 'refusal', diagnostic: { code: 'MCP_COMMAND_CONFLICT', server: 'synthetic', sources: [source, { ...source, slug: 'other' }] } })
})

it('parses standard sibling declarations without carrying environment values', () => {
    const bytes = JSON.stringify({ mcpServers: { synthetic: { command: 'node', args: ['server.mjs'], env: { SYNTHETIC_TOKEN: '${SYNTHETIC_TOKEN}' } } } })
    const parsed = parseMcpDeclarationFile({ bytes, source: { ...source, sha256: createHash('sha256').update(bytes).digest('hex') }, workingDirectory: '/synthetic/service' })
    expect(parsed.kind).toBe('complete')
    if (parsed.kind !== 'complete') return
    expect(parsed.declarations[0]).toMatchObject({ command: 'node', envNames: ['SYNTHETIC_TOKEN'], cwd: '/synthetic/service' })
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: parsed.declarations, approved: [], targets })
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
    const outcome = collectMcpDeclarations({ cockpitDirectory: '/synthetic/cockpit', declarations: [{ ...declaration, env: { SYNTHETIC_TOKEN: canary } }], approved: [], targets })
    expect(outcome.kind).toBe('refusal')
    expect(JSON.stringify(outcome)).not.toContain(canary)
})

it('refuses non-own, oversized and stale-source input before returning servers', () => {
    let reads = 0
    const input = { cockpitDirectory: '/synthetic/cockpit', declarations: [declaration], approved: [], targets }
    expect(collectMcpDeclarations(new Proxy(input, {})).kind).toBe('refusal')
    const accessor = Object.defineProperty({}, 'declarations', { enumerable: true, get: () => { reads += 1; return [] } })
    expect(collectMcpDeclarations(accessor).kind).toBe('refusal')
    expect(reads).toBe(0)
    expect(collectMcpDeclarations({ ...input, declarations: [{ ...declaration, args: ['x'.repeat(65_537)] }] }).kind).toBe('refusal')
    expect(parseMcpDeclarationFile({ bytes: '{}', source, workingDirectory: '/synthetic/service' }).kind).toBe('refusal')
})
