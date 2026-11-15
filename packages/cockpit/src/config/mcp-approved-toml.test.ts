import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { sha256Hex } from '../sha256.js'
import { loadCockpitConfig } from './load.js'
import { recordMcpApprovals } from './mcp-approved-toml.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const base = ['# The team keeps this comment.', '[cockpit]', 'name = "approvals"', 'siblings_root = "."', '',
    '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"', 'purpose = "Synthetic app"', '',
    '[ports]', 'bases = {}'].join('\n')

async function record(text: string, approvals: Readonly<Record<string, string>>) {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-mcp-approved-'))
    roots.push(root)
    const path = join(root, 'cockpit.toml')
    writeFileSync(path, text)
    const loaded = await loadCockpitConfig(path)
    if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded.diagnostics))
    const written = await recordMcpApprovals(path, text, sha256Hex(text), loaded.result.config, approvals)
    const after = await loadCockpitConfig(path)
    return { written, text: readFileSync(path, 'utf8'), approved: after.kind === 'complete' ? after.result.config.mcp.approved : undefined }
}

it('records approvals in [mcp.approved], adding the table or replacing a changed digest, and leaves every other byte', async () => {
    const added = await record(base, { docs: 'a'.repeat(64), search: 'b'.repeat(64) })
    expect(added.written).toEqual({ kind: 'complete', sha256: sha256Hex(added.text) })
    expect(added.approved).toEqual({ docs: 'a'.repeat(64), search: 'b'.repeat(64) })
    expect(added.text.startsWith(`${base}\n`)).toBe(true)

    const existing = `${base}\n\n[mcp.approved]\ndocs = "${'a'.repeat(64)}"\n"search" = "${'b'.repeat(64)}"\n\n[guards]\nprotected_branches = ["main"]\n`
    const replaced = await record(existing, { search: 'c'.repeat(64), maps: 'd'.repeat(64) })
    expect(replaced.written).toEqual({ kind: 'complete', sha256: sha256Hex(replaced.text) })
    expect(replaced.approved).toEqual({ docs: 'a'.repeat(64), search: 'c'.repeat(64), maps: 'd'.repeat(64) })
    expect(replaced.text).toContain('[guards]\nprotected_branches = ["main"]\n')

    // An inline table cannot take a line of its own, so the edit is refused by name rather than guessed at.
    const inline = await record(`${base}\n\n[mcp]\napproved = { docs = "${'a'.repeat(64)}" }\n`, { search: 'b'.repeat(64) })
    expect(inline.written).toMatchObject({ kind: 'refused', code: 'CONFIG_SCHEMA_INVALID', message: expect.stringContaining('[mcp.approved] table') })
    expect(inline.approved).toEqual({ docs: 'a'.repeat(64) })
})
