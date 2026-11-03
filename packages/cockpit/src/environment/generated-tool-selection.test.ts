import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { checkGeneratedEnvironment, syncGeneratedEnvironment } from '../generated-environment/command.js'
import { HARNESS_REGISTRY, type SurfaceTarget } from '../surfaces/harness-registry.js'

const fixture = resolve('fixtures/registries/generated-environment.toml')
const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function consumer(tools: readonly SurfaceTarget[]): Promise<{ root: string; configPath: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-tool-selection-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    await writeFile(configPath, `${(await readFile(fixture, 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
    )}\n[surfaces]\ntools = ${JSON.stringify(tools)}\n`)
    await mkdir(join(root, 'app'), { recursive: true })
    await mkdir(join(root, 'fixtures'), { recursive: true })
    await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    return { root, configPath }
}

// The directories only one tool reads; AGENTS.md, .cockpit/ and the environment files are shared.
const TOOL_DIRECTORIES: Readonly<Record<SurfaceTarget, readonly string[]>> = {
    claudecode: ['.claude/', 'CLAUDE.md', '.mcp.json'],
    codexcli: ['.codex/', '.agents/'],
    opencode: ['.opencode/', 'opencode.jsonc'],
    cursor: ['.cursor/'],
    grokcli: ['.grok/'],
}
const owner = (path: string) => (Object.keys(TOOL_DIRECTORIES) as SurfaceTarget[])
    .filter(target => TOOL_DIRECTORIES[target].some(prefix => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix))

describe('tool selection', () => {
    it.each(['claudecode', 'codexcli', 'opencode'] as const)('renders and checks only %s when it is the one listed tool', async tool => {
        const { configPath } = await consumer([tool])
        const synced = await syncGeneratedEnvironment({ configPath })
        expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete' })
        if (synced.kind !== 'complete') return
        const paths = synced.result.paths
        expect(paths.flatMap(owner).filter(target => target !== tool)).toEqual([])
        expect(paths).toContain('AGENTS.md')
        expect(paths).toContain(`${HARNESS_REGISTRY.find(row => row.target === tool)!.outputs.skills}/cockpit-setup/SKILL.md`)
        expect(paths.includes('CLAUDE.md')).toBe(tool === 'claudecode')
        expect(synced.diagnostics.filter(row => row.target !== undefined && owner(row.target.replace(/^[a-z]+:/, '')).some(target => target !== tool)))
            .toEqual([])
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    }, 120_000)

    it('writes an unmeasured tool once it is listed and leaves its files to the stale-removal approval once it is not', async () => {
        const { root, configPath } = await consumer(['claudecode'])
        expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        await expect(access(join(root, '.cursor'))).rejects.toMatchObject({ code: 'ENOENT' })

        const listed = (await readFile(configPath, 'utf8')).replace('tools = ["claudecode"]', 'tools = ["claudecode","cursor"]')
        await writeFile(configPath, listed)
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'refusal',
            diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT', target: expect.stringMatching(/^\.cursor\//) })]) })
        const added = await syncGeneratedEnvironment({ configPath })
        expect(added).toMatchObject({ kind: 'complete' })
        await access(join(root, '.cursor/skills/cockpit-setup/SKILL.md'))

        await writeFile(configPath, listed.replace('tools = ["claudecode","cursor"]', 'tools = ["claudecode"]'))
        const removed = await syncGeneratedEnvironment({ configPath })
        expect(removed).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_STALE_APPROVAL_REQUIRED' })] })
        await access(join(root, '.cursor/skills/cockpit-setup/SKILL.md'))
    }, 120_000)
})
