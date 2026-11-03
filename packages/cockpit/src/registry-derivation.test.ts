import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'

import { deriveRegistry } from './registry-derivation.js'
import { CockpitConfig, type CockpitConfig as CockpitConfigValue } from './schema.js'

const fixturePath = resolve('fixtures/registries/generated-environment.toml')

function baseline(): CockpitConfigValue {
    return CockpitConfig.parse(parse(readFileSync(fixturePath, 'utf8')))
}

function derivedConfig(): Record<string, unknown> {
    const config = structuredClone(baseline())
    const provenance = { source: 'overlay.toml', observed_on: '2026-09-26', kind: 'declared', reason: 'Synthetic declaration' }
    config.sibling.push({
        slug: 'worker',
        dir: 'worker',
        mount: 'profile:worker',
        acquire: 'none',
        var: 'WORKER_DIR',
        toolchain: 'node',
        purpose: 'Synthetic profile worker',
        environment_files: [{ template: '.env.worker.example', instance: '.env.worker' }],
        derives: { mcp_sources: [{ path: '.mcp.json', provenance }] },
    } as never)
    return config as unknown as Record<string, unknown>
}

describe('registry derivation', () => {
    it('indexes the MCP sources and secret paths the siblings declare and drops derives from the configuration', () => {
        const result = deriveRegistry(derivedConfig())
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.result.mcpSources).toEqual([{
            slug: 'worker', siblingDir: 'worker', path: '.mcp.json',
            provenance: { source: 'overlay.toml', observed_on: '2026-09-26', kind: 'declared', reason: 'Synthetic declaration' },
        }])
        expect(result.result.config.sibling[1].environment_files).toEqual([
            { template: '.env.worker.example', instance: '.env.worker' },
        ])
        expect(result.result.secretPaths).toEqual([
            { slug: 'app', siblingDir: 'app', path: '.env', kind: 'instance' },
            { slug: 'worker', siblingDir: 'worker', path: '.env.worker', kind: 'instance' },
        ])
        expect(result.result.config.sibling[1]).not.toHaveProperty('derives')
    })

    it.each([
        ['missing provenance', (config: any) => { delete config.sibling[1].derives.mcp_sources[0].provenance }],
        ['empty derives', (config: any) => { config.sibling[1].derives.mcp_sources = [] }],
        ['duplicate MCP reference', (config: any) => { config.sibling[1].derives.mcp_sources.push(config.sibling[1].derives.mcp_sources[0]) }],
        ['unsafe MCP reference', (config: any) => { config.sibling[1].derives.mcp_sources[0].path = '../mcp.json' }],
        ['a generated row', (config: any) => { config.sibling[1].derives.generated = {} }],
    ])('refuses %s without returning a partial candidate', (_label, mutate) => {
        const config = derivedConfig()
        mutate(config)
        const result = deriveRegistry(config)
        expect(result).toMatchObject({ kind: 'refusal', code: 'REGISTRY_INPUT_INVALID' })
        expect(result).not.toHaveProperty('result')
    })
})
