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
    const service = structuredClone(config.environment.generated!.services[0]!)
    const policy = structuredClone(config.environment.install_policies[0]!)
    const provenance = structuredClone(service.provenance)
    const operationOwners = [
        service.image!.manifest_probe,
        service.image!.registry_auth_probe,
        service.health.probe,
        service.health.tool_probe,
    ]
    for (const operation of operationOwners) if (operation) operation.service = 'worker'
    service.ports = [{ name: 'http', host_variable: 'WORKER_HOST_PORT', internal: 3000 }]
    const { id: _id, sibling: _sibling, mounts: _mounts, profiles: _profiles, ...derivedService } = service
    void _id
    void _sibling
    void _mounts
    void _profiles

    const decision = (id: string, subject: string, subject_id: string) => ({
        id,
        subject,
        subject_id,
        decided_on: '2026-09-26',
        decision: `Synthetic ${subject}`,
        rejected: ['Undeclared structure'],
        reason: 'Reproducible environment',
        reviewer: 'consumer-maintainer',
        provenance,
    })

    config.sibling.push({
        slug: 'worker',
        dir: 'worker',
        mount: 'profile:worker',
        acquire: 'none',
        var: 'WORKER_DIR',
        toolchain: 'node',
        purpose: 'Synthetic profile worker',
        environment_files: [{ template: '.env.worker.example', instance: '.env.worker' }],
        derives: {
            generated: {
                service: derivedService,
                checkout_mount: { target: '/workspace/worker', source_type: 'directory' },
                additional_mounts: [{ kind: 'volume', source: 'worker-dependencies', target: '/workspace/node_modules' }],
                port_defaults: { WORKER_HOST_PORT: 4250 },
                entrypoints: [{ name: 'worker-origin', kind: 'origin', port: 'WORKER_HOST_PORT', path: '/',
                    hostname: 'worker.sample.localhost', scheme: 'https' }],
                volumes: [{ id: 'worker-dependencies', purpose: 'dependencies', install_policy: 'worker-dependencies', target: '/workspace/node_modules', provenance }],
                install_policies: [{ ...policy, volume: 'worker-dependencies', lockfile: 'worker/package-lock.json' }],
                decisions: [
                    decision('service-worker', 'service', 'worker'),
                    decision('volume-worker-dependencies', 'volume', 'worker-dependencies'),
                    decision('mount-worker-checkout', 'mount', 'worker:bind:.:/workspace/worker'),
                    decision('mount-worker-dependencies', 'mount', 'worker:volume:worker-dependencies:/workspace/node_modules'),
                    decision('port-worker-http', 'port', 'worker:http'),
                ],
                provenance,
            },
            mcp_sources: [{ path: '.mcp.json', format: 'mcp-json', provenance }],
        },
    } as never)
    return config as unknown as Record<string, unknown>
}

describe('registry derivation', () => {
    it('folds one profile sibling into the complete effective configuration and reference indexes', () => {
        const result = deriveRegistry(derivedConfig())
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return

        const worker = result.result.config.environment.generated!.services.find(({ id }) => id === 'worker')!
        expect(worker).toMatchObject({
            id: 'worker', sibling: 'worker', profiles: ['worker'],
            mounts: [
                { kind: 'bind', source: '.', target: '/workspace/worker', source_type: 'directory' },
                { kind: 'volume', source: 'worker-dependencies', target: '/workspace/node_modules' },
            ],
        })
        expect(result.result.config.ports.bases.WORKER_HOST_PORT).toBe(4250)
        expect(result.result.config.environment.entrypoint_derivatives).toContainEqual({
            name: 'worker-origin', kind: 'origin', port: 'WORKER_HOST_PORT', path: '/',
            hostname: 'worker.sample.localhost', scheme: 'https',
        })
        expect(result.result.mcpSources).toEqual([{
            slug: 'worker', siblingDir: 'worker', path: '.mcp.json', format: 'mcp-json',
            provenance: worker.provenance,
        }])
        expect(result.result.config.sibling[1].environment_files).toEqual([
            { template: '.env.worker.example', instance: '.env.worker' },
        ])
        expect(result.result.secretPaths).toEqual([
            { slug: 'app', siblingDir: 'app', path: '.env', kind: 'instance' },
            { slug: 'worker', siblingDir: 'worker', path: '.env.worker', kind: 'instance' },
        ])
        expect(result.result.origins).toEqual([{ slug: 'worker', provenance: worker.provenance }])
        expect(result.result.config.sibling[1]).not.toHaveProperty('derives')
        expect(Object.isFrozen(result.result)).toBe(true)
        expect(Object.isFrozen(result.result.config)).toBe(true)
    })

    it.each([
        ['missing provenance', (config: any) => { delete config.sibling[1].derives.generated.provenance }],
        ['generated host row', (config: any) => {
            config.sibling[1].mount = 'host'
            config.sibling[1].gate = 'operator'
            config.sibling[1].host_reason = 'Requires a host display'
        }],
        ['missing row port default', (config: any) => { config.sibling[1].derives.generated.port_defaults = {} }],
        ['extra row port default', (config: any) => { config.sibling[1].derives.generated.port_defaults.EXTRA_PORT = 4300 }],
        ['equal global port authority', (config: any) => {
            config.sibling[1].derives.generated.port_defaults = { APP_HOST_PORT: 4100 }
            config.sibling[1].derives.generated.service.ports[0].host_variable = 'APP_HOST_PORT'
            config.sibling[1].derives.generated.entrypoints[0].port = 'APP_HOST_PORT'
        }],
        ['foreign entrypoint port', (config: any) => { config.sibling[1].derives.generated.entrypoints[0].port = 'APP_HOST_PORT' }],
        ['foreign decision subject', (config: any) => { config.sibling[1].derives.generated.decisions[0].subject_id = 'app' }],
        ['duplicate volume identity', (config: any) => {
            config.sibling[1].derives.generated.volumes[0].id = 'dependencies'
            config.sibling[1].derives.generated.volumes[0].install_policy = 'dependencies'
            config.sibling[1].derives.generated.install_policies[0].volume = 'dependencies'
            config.sibling[1].derives.generated.additional_mounts[0].source = 'dependencies'
        }],
        ['duplicate policy selector', (config: any) => { config.sibling[1].derives.generated.install_policies[0].lockfile = 'package-lock.json' }],
        ['existing generated cross-check failure', (config: any) => { config.sibling[1].derives.generated.service.health.probe.service = 'app' }],
        ['duplicate MCP reference', (config: any) => { config.sibling[1].derives.mcp_sources.push(config.sibling[1].derives.mcp_sources[0]) }],
        ['unsafe MCP reference', (config: any) => { config.sibling[1].derives.mcp_sources[0].path = '../mcp.json' }],
    ])('refuses %s without returning a partial candidate', (_label, mutate) => {
        const config = derivedConfig()
        mutate(config)
        const result = deriveRegistry(config)
        expect(result.kind).toBe('refusal')
        expect(result).not.toHaveProperty('result')
    })

    it('names the missing global generated baseline', () => {
        const config = derivedConfig() as any
        delete config.environment.generated
        expect(deriveRegistry(config)).toMatchObject({
            kind: 'refusal', code: 'REGISTRY_GENERATED_BASELINE_MISSING',
        })
    })

    it.each([
        ['accessor', () => Object.defineProperty(derivedConfig(), 'cockpit', { enumerable: true, get: () => ({ name: 'synthetic' }) })],
        ['proxy', () => new Proxy(derivedConfig(), {})],
        ['oversize', () => ({ ...derivedConfig(), oversized: 'x'.repeat(1_048_577) })],
    ])('refuses %s input before reading derivation authority', (_label, input) => {
        expect(deriveRegistry(input())).toMatchObject({ kind: 'refusal', code: 'REGISTRY_INPUT_INVALID' })
    })
})
