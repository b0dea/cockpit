import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadCockpitConfig } from '../config/load.js'
import { authenticateGeneratedComposeArtifact, authenticateGeneratedRender } from './generated-render.js'
import { projectGeneratedComposeArtifactAuthority, renderGeneratedEnvironment } from './generated-stack.js'

const fixturePath = resolve('fixtures/registries/generated-environment.toml')
const sourceSha256 = 'a'.repeat(64)
const generation = 'b'.repeat(64)

describe('generated Compose artifact authority', () => {
    it('refuses caller-authored Compose even when its digests match', async () => {
        const loaded = await loadCockpitConfig(fixturePath)
        expect(loaded.kind).toBe('complete')
        if (loaded.kind !== 'complete' || !loaded.result.config.environment.generated) return
        const rendered = renderGeneratedEnvironment({
            declaration: loaded.result.config.environment.generated,
            sourceSha256,
            generation,
            stackId: `stack:${'c'.repeat(64)}`,
            cockpitId: `cockpit:render-authority:${'d'.repeat(64)}`,
            portDefaults: loaded.result.config.ports.bases,
            siblingDirectories: { app: 'app' },
        })
        expect(rendered.kind).toBe('complete')
        if (rendered.kind !== 'complete') return
        const compose = rendered.manifest.find(({ path }) =>
            path === loaded.result.config.environment.generated?.compose_file)
        expect(compose).toBeDefined()
        if (!compose) return

        const callerAuthored = {
            ...rendered,
            compose: compose.bytes,
            manifest: rendered.manifest.map((file) => file.path === compose.path
                ? { ...file, sha256: createHash('sha256').update(compose.bytes).digest('hex') }
                : file),
        }
        expect(projectGeneratedComposeArtifactAuthority(callerAuthored)).toBeUndefined()

        const metadata = authenticateGeneratedRender(rendered)
        expect(metadata).toBeDefined()
        if (!metadata) return
        expect(Reflect.set(metadata.declaration.services[0]!.image!, 'reference', 'synthetic.invalid/mutated:latest')).toBe(false)
        expect(Reflect.set(metadata.declaration.services[0]!.health.probe, 'timeout_seconds', 1)).toBe(false)

        const authority = projectGeneratedComposeArtifactAuthority(rendered)
        expect(authority).toBeDefined()
        if (!authority) return
        const candidate = {
            reference: compose.path,
            source: compose.bytes,
            sha256: compose.sha256,
            sourceSha256,
        }
        expect(authenticateGeneratedComposeArtifact(authority, candidate)).toBe(true)
        expect(authenticateGeneratedComposeArtifact({ ...authority }, candidate)).toBe(false)
        expect(authenticateGeneratedComposeArtifact(authority, {
            ...candidate,
            source: `${candidate.source}\n`,
            sha256: createHash('sha256').update(`${candidate.source}\n`).digest('hex'),
        })).toBe(false)
        expect(projectGeneratedComposeArtifactAuthority(new Proxy(rendered, {
            get: () => { throw new Error('must not run') },
        }))).toBeUndefined()
    })
})
