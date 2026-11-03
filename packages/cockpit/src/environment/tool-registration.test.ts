import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadCockpitConfig } from '../config/load.js'
import { runToolChange } from './tool-registration.js'

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const BASE = [
    '# Keep this comment: it belongs to the maintainers.',
    '[cockpit]', 'name = "synthetic-tools"', 'siblings_root = "."', '',
    '[[sibling]]', 'slug = "api"', 'dir = "api"', 'mount = "none"', 'acquire = "none"', 'var = "API_DIR"', 'purpose = "Synthetic API"', '',
    '[ports.bases]', '',
].join('\n')

async function cockpit(text: string): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-tool-test-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, text)
    return configPath
}

async function tools(configPath: string): Promise<readonly string[]> {
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete') throw new Error(`config is invalid: ${loaded.diagnostics[0]?.message}`)
    return loaded.result.config.surfaces.tools
}

describe('tool add and remove', () => {
    it('edits only the tools line, adding a [surfaces] table to a file that has none and keeping the written order', async () => {
        const configPath = await cockpit(BASE)
        expect(await runToolChange({ operation: 'add', configPath, tool: 'cursor', dryRun: true })).toMatchObject({ status: 0, result: { action: 'previewed' } })
        expect(await readFile(configPath, 'utf8')).toBe(BASE)

        expect(await runToolChange({ operation: 'add', configPath, tool: 'cursor', dryRun: false })).toMatchObject({ status: 0, result: { action: 'added' } })
        expect(await readFile(configPath, 'utf8')).toBe(`${BASE}\n[surfaces]\ntools = ["claudecode", "codexcli", "opencode", "cursor"]\n`)
        expect(await runToolChange({ operation: 'add', configPath, tool: 'cursor', dryRun: false })).toMatchObject({ status: 0, result: { action: 'unchanged' } })

        const ordered = await cockpit(`${BASE}\n[surfaces]\nbundles = []\ntools = ["opencode", "claudecode"] # opencode first\n`)
        await runToolChange({ operation: 'remove', configPath: ordered, tool: 'claudecode', dryRun: false })
        expect(await readFile(ordered, 'utf8')).toBe(`${BASE}\n[surfaces]\nbundles = []\ntools = ["opencode"] # opencode first\n`)
        await runToolChange({ operation: 'add', configPath: ordered, tool: 'codexcli', dryRun: false })
        expect(await tools(ordered)).toEqual(['opencode', 'codexcli'])
    })

    it('refuses an edit the schema or the file layout does not allow, and writes nothing', async () => {
        const single = `${BASE}\n[surfaces]\ntools = ["claudecode", "cursor"]\n`
        const configPath = await cockpit(single)
        expect(await runToolChange({ operation: 'remove', configPath, tool: 'claudecode', dryRun: false })).toMatchObject({ status: 2,
            diagnostics: [expect.objectContaining({ code: 'CONFIG_SCHEMA_INVALID', message: expect.stringContaining('at least one tool cockpit has a guard for') })] })
        expect(await readFile(configPath, 'utf8')).toBe(single)

        const multiline = `${BASE}\n[surfaces]\ntools = [\n  "claudecode",\n]\n`
        const multilinePath = await cockpit(multiline)
        expect(await runToolChange({ operation: 'add', configPath: multilinePath, tool: 'opencode', dryRun: false })).toMatchObject({ status: 2,
            diagnostics: [expect.objectContaining({ code: 'CONFIG_SCHEMA_INVALID', message: expect.stringContaining('not written on one line') })] })
        expect(await readFile(multilinePath, 'utf8')).toBe(multiline)

        expect(await runToolChange({ operation: 'add', configPath, tool: 'vim', dryRun: false })).toMatchObject({ status: 2,
            diagnostics: [expect.objectContaining({ code: 'CLI_USAGE_INVALID' })] })
    })
})
