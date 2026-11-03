import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SURFACE_TOOLS } from '../surfaces/harness-registry.js'
import { inspectSiblingInstructions, synchronizeSiblingInstructionFiles } from './sibling-instructions.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function estate(): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-sibling-instructions-')))
    roots.push(root)
    return root
}

async function repository(base: string, slug: string, files: Readonly<Record<string, string>>): Promise<{ slug: string; root: string }> {
    const root = join(base, slug)
    await mkdir(root)
    for (const [path, bytes] of Object.entries(files)) {
        await mkdir(join(root, path, '..'), { recursive: true })
        await writeFile(join(root, path), bytes)
    }
    return { slug, root }
}

describe('sibling instruction files', () => {
    it('warns for each layout that leaves an agent tool without the instructions, and stays quiet once CLAUDE.md imports AGENTS.md', async () => {
        const base = await estate()
        const codes = async (files: Readonly<Record<string, string>>, slug: string, tools: readonly string[] = DEFAULT_SURFACE_TOOLS) =>
            (await inspectSiblingInstructions(await repository(base, slug, files), tools)).map(row => row.code)

        expect(await codes({ 'AGENTS.md': '# Guide\n' }, 'agents')).toEqual(['SIBLING_INSTRUCTIONS_AGENTS_ONLY'])
        expect(await codes({ 'CLAUDE.md': '# Guide\n' }, 'claude')).toEqual(['SIBLING_INSTRUCTIONS_CLAUDE_ONLY'])
        expect(await codes({ 'AGENTS.md': '# Shared\n', 'CLAUDE.md': '# Claude only\n' }, 'unlinked')).toEqual(['SIBLING_INSTRUCTIONS_UNLINKED'])
        expect(await codes({ 'README.md': '# Product\n' }, 'neither')).toEqual(['SIBLING_INSTRUCTIONS_MISSING'])
        expect(await codes({ 'AGENTS.md': '# Shared\n', 'CLAUDE.md': '@AGENTS.md\n\nClaude-only note: mail ops@example.test.\n' }, 'linked')).toEqual([])
        expect(await codes({ 'AGENTS.md': '# Shared\n', 'GEMINI.md': '# Gemini\n', '.cursor/rules/style.mdc': 'Style\n' }, 'tooled'))
            .toEqual(['SIBLING_INSTRUCTIONS_AGENTS_ONLY', 'SIBLING_INSTRUCTIONS_TOOL_ONLY'])

        // Only a listed tool that misses the instructions is a finding: a Claude Code team loses nothing
        // to a CLAUDE.md-only repository, and a Codex team nothing to an AGENTS.md-only one.
        expect(await codes({ 'CLAUDE.md': '# Guide\n' }, 'claude-team', ['claudecode'])).toEqual([])
        expect(await codes({ 'AGENTS.md': '# Shared\n', 'CLAUDE.md': '# Claude only\n' }, 'claude-unlinked', ['claudecode'])).toEqual([])
        expect(await codes({ 'AGENTS.md': '# Guide\n' }, 'claude-agents', ['claudecode'])).toEqual(['SIBLING_INSTRUCTIONS_AGENTS_ONLY'])
        expect(await codes({ 'AGENTS.md': '# Guide\n' }, 'codex-team', ['codexcli'])).toEqual([])
        expect(await codes({ 'CLAUDE.md': '# Guide\n' }, 'opencode-team', ['opencode'])).toEqual([])

        // A CLAUDE.md that is a link to AGENTS.md is the same file to every tool.
        const symlinked = await repository(base, 'symlinked', { 'AGENTS.md': '# Shared\n' })
        await symlink('AGENTS.md', join(symlinked.root, 'CLAUDE.md'))
        expect(await inspectSiblingInstructions(symlinked, DEFAULT_SURFACE_TOOLS)).toEqual([])

        const imports = await inspectSiblingInstructions(await repository(base, 'imports', { 'CLAUDE.md': 'See @docs/testing.md\n' }), DEFAULT_SURFACE_TOOLS)
        expect(imports).toEqual([expect.objectContaining({
            severity: 'warning', code: 'SIBLING_INSTRUCTIONS_CLAUDE_ONLY', target: 'sibling:imports',
            message: expect.stringContaining('imports other files with @'),
        })])
    })

    it('proposes, then on approval writes, only the two changes that need no judgement', async () => {
        const base = await estate()
        const agents = await repository(base, 'agents', { 'AGENTS.md': '# Shared guide\n' })
        expect(await synchronizeSiblingInstructionFiles({ siblingRoot: agents.root, write: false }))
            .toEqual({ kind: 'offered', root: agents.root, change: 'claude-import' })
        await expect(readFile(join(agents.root, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await synchronizeSiblingInstructionFiles({ siblingRoot: agents.root, write: true }))
            .toEqual({ kind: 'written', root: agents.root, change: 'claude-import' })
        expect(await readFile(join(agents.root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
        expect(await readFile(join(agents.root, 'AGENTS.md'), 'utf8')).toBe('# Shared guide\n')
        expect(await inspectSiblingInstructions(agents, DEFAULT_SURFACE_TOOLS)).toEqual([])
        expect(await synchronizeSiblingInstructionFiles({ siblingRoot: agents.root, write: true })).toEqual({ kind: 'none', root: agents.root })

        const original = '# Team guide\r\n\r\nRun the tests before handing back.\r\nNo trailing newline'
        const claude = await repository(base, 'claude', { 'CLAUDE.md': original })
        expect(await synchronizeSiblingInstructionFiles({ siblingRoot: claude.root, write: true }))
            .toEqual({ kind: 'written', root: claude.root, change: 'move-to-agents' })
        expect(await readFile(join(claude.root, 'AGENTS.md'), 'utf8')).toBe(original)
        expect(await readFile(join(claude.root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
        expect(await inspectSiblingInstructions(claude, DEFAULT_SURFACE_TOOLS)).toEqual([])

        // Moved, an @-import would reach Claude Code alone, so a person decides what goes where.
        const imports = await repository(base, 'imports', { 'CLAUDE.md': '@docs/testing.md\n' })
        expect(await synchronizeSiblingInstructionFiles({ siblingRoot: imports.root, write: true })).toEqual({ kind: 'none', root: imports.root })
        await expect(readFile(join(imports.root, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        const unlinked = await repository(base, 'unlinked', { 'AGENTS.md': '# Shared\n', 'CLAUDE.md': '# Claude\n' })
        expect(await synchronizeSiblingInstructionFiles({ siblingRoot: unlinked.root, write: true })).toEqual({ kind: 'none', root: unlinked.root })
        expect(await readFile(join(unlinked.root, 'CLAUDE.md'), 'utf8')).toBe('# Claude\n')
    })

    it('refuses to move a CLAUDE.md that is a link, and leaves both files as they were', async () => {
        const base = await estate()
        await writeFile(join(base, 'outside.md'), '# Elsewhere\n')
        const linked = await repository(base, 'linked', {})
        await symlink('../outside.md', join(linked.root, 'CLAUDE.md'))

        expect(await synchronizeSiblingInstructionFiles({ siblingRoot: linked.root, write: true })).toEqual({
            kind: 'refusal', root: linked.root, reason: 'CLAUDE.md is not an ordinary file',
        })
        await expect(readFile(join(linked.root, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(base, 'outside.md'), 'utf8')).toBe('# Elsewhere\n')
    })
})
