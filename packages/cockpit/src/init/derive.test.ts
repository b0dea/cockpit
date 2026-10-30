import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveInferredFacts } from './derive.js'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })

function estate(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-derive-'))
    scratch.push(root)
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, '..'), { recursive: true })
        writeFileSync(join(root, path), text)
    }
    return root
}

const api = [{ slug: 'api', path: 'api' }]
const byTarget = (facts: readonly { target: string }[], target: string) => facts.find(fact => fact.target === target)

describe('inferred interview answers', () => {
    it('reads the final Dockerfile stage for the run command and exposed ports, naming the file', async () => {
        const root = estate({ 'api/Dockerfile': [
            'FROM node:22 AS build', 'EXPOSE 9999', 'CMD ["node", "build.mjs"]',
            'FROM node:22-slim', 'ENTRYPOINT ["node"]', 'CMD ["server.mjs"]', 'EXPOSE 3000/tcp 8080', ''].join('\n') })
        const { facts } = await deriveInferredFacts({ root, repositories: api })
        expect(byTarget(facts, 'api.command')).toMatchObject({ value: ['node', 'server.mjs'],
            provenance: { kind: 'inferred', source: 'api/Dockerfile' } })
        expect(byTarget(facts, 'api.container_ports')).toMatchObject({ value: [3000, 8080],
            provenance: { kind: 'inferred', source: 'api/Dockerfile' } })
    })

    it('records .env.example variable names and never their values', async () => {
        const root = estate({ 'api/.env.example': 'DATABASE_URL=postgres://user:hunter2@db/app\n# NOTE=skip\nexport TOKEN=abc123\nnot a name=1\n' })
        const result = await deriveInferredFacts({ root, repositories: api })
        expect(byTarget(result.facts, 'api.env_names')).toMatchObject({ value: ['DATABASE_URL', 'TOKEN'],
            provenance: { kind: 'inferred', source: 'api/.env.example' } })
        expect(JSON.stringify(result)).not.toMatch(/hunter2|abc123/)
    })

    it('asks which non-local host each database or vendor variable names, from template names only', async () => {
        const root = estate({
            'api/.env.example': 'DATABASE_URL=postgres://user:hunter2@db.internal/app\nLOG_LEVEL=debug\n',
            'api/.env.staging.example': 'STRIPE_API_BASE=https://vendor.invalid/v1\n',
            'api/.env': 'ANALYTICS_DB_URL=never-read\n',
        })
        const result = await deriveInferredFacts({ root, repositories: api })
        const guards = result.facts.filter(fact => fact.fields.includes('guards'))
        expect(guards).toEqual([
            expect.objectContaining({ target: 'guards.hosted_db_hosts', value: expect.objectContaining({ variable: 'DATABASE_URL',
                ask: expect.stringContaining('production, staging, shared') }), provenance: expect.objectContaining({ source: 'api/.env.example' }) }),
            expect.objectContaining({ target: 'guards.vendor_endpoint_hosts', value: expect.objectContaining({ variable: 'STRIPE_API_BASE' }),
                provenance: expect.objectContaining({ source: 'api/.env.staging.example' }) }),
        ])
        expect(JSON.stringify(result)).not.toMatch(/hunter2|db\.internal|vendor\.invalid|ANALYTICS_DB_URL/)
    })

    it('proposes compose-first for an existing Compose file and workflow services with their images', async () => {
        const root = estate({
            'api/compose.yml': 'services:\n  api:\n    build: .\n',
            '.github/workflows/ci.yml': 'jobs:\n  test:\n    services:\n      postgres:\n        image: postgres:16\n      cache:\n        image: redis:7\n',
        })
        const { facts } = await deriveInferredFacts({ root, repositories: api })
        expect(byTarget(facts, 'environment.compose_files')).toMatchObject({ value: ['api/compose.yml'],
            provenance: { kind: 'inferred', source: 'api/compose.yml' } })
        expect(byTarget(facts, 'services.postgres')).toMatchObject({ value: { image: 'postgres:16' },
            provenance: { source: '.github/workflows/ci.yml' } })
        expect(byTarget(facts, 'services.cache')).toMatchObject({ value: { image: 'redis:7' } })
    })

    it('does not infer facts through a symlinked repository directory ancestor', async () => {
        const root = estate({})
        const outside = estate({
            'workflows/probe.yml': 'jobs:\n  test:\n    services:\n      database:\n        image: marker.invalid/outside\n',
        })
        symlinkSync(outside, join(root, '.github'), 'dir')

        const result = await deriveInferredFacts({ root, repositories: api })

        expect(byTarget(result.facts, 'services.database')).toBeUndefined()
        expect(result.skipped).toContainEqual(expect.objectContaining({
            source: '.github/workflows',
            reason: expect.stringContaining('redirected directory'),
        }))
        expect(JSON.stringify(result)).not.toContain('marker.invalid/outside')
        expect(JSON.stringify(result)).not.toContain(outside)
    })

    it('proposes the cockpit root as the first sibling only when no repository was observed', async () => {
        const parent = estate({})
        mkdirSync(join(parent, 'product-notes'))
        const root = join(parent, 'product-notes')
        const { facts } = await deriveInferredFacts({ root, repositories: [] })
        expect(byTarget(facts, 'sibling.product-notes')).toEqual({ fields: ['sibling'], target: 'sibling.product-notes',
            value: { slug: 'product-notes', dir: '.', mount: 'none', acquire: 'none', var: 'PRODUCT_NOTES_DIR' },
            provenance: expect.objectContaining({ kind: 'inferred', source: '.' }) })
        mkdirSync(join(parent, 'compose-product'))
        const reserved = await deriveInferredFacts({ root: join(parent, 'compose-product'), repositories: [] })
        expect(byTarget(reserved.facts, 'sibling.compose-product')).toMatchObject({
            value: { slug: 'compose-product', dir: '.', var: 'SIBLING_COMPOSE_PRODUCT_DIR' },
        })
        // With repositories observed, each one is proposed and the root is not.
        const observed = await deriveInferredFacts({ root, repositories: api })
        expect(observed.facts.filter(fact => fact.fields.includes('sibling'))).toEqual([expect.objectContaining({ target: 'sibling.api' })])
    })

    it('proposes the product repository a dedicated cockpit sits beside as its sibling', async () => {
        const parent = estate({ 'shop/package.json': '{}\n' })
        mkdirSync(join(parent, 'shop-cockpit'))
        const { facts } = await deriveInferredFacts({ root: parent, configurationRoot: join(parent, 'shop-cockpit'),
            repositories: [{ slug: 'shop', path: 'shop' }] })
        expect(facts.filter(fact => fact.fields.includes('sibling'))).toEqual([{ fields: ['sibling'], target: 'sibling.shop',
            value: { slug: 'shop', dir: 'shop', mount: 'always', acquire: 'none', var: 'SHOP_DIR' },
            provenance: expect.objectContaining({ kind: 'inferred', source: '../shop' }) }])
    })

    it('reads an in-repo cockpit\'s root once, as the repository at "." that is its own first sibling', async () => {
        const parent = estate({ 'shop/Dockerfile': 'FROM node:22\nEXPOSE 3000\nCMD ["node", "server.mjs"]\n',
            'shop/.env.example': 'DATABASE_URL=\n' })
        const { facts } = await deriveInferredFacts({ root: join(parent, 'shop'), repositories: [{ slug: 'shop', path: '.' }] })
        expect(byTarget(facts, 'shop.command')).toMatchObject({ value: ['node', 'server.mjs'], provenance: { source: 'Dockerfile' } })
        expect(byTarget(facts, 'sibling.shop')).toMatchObject({ value: { slug: 'shop', dir: '.' } })
        expect(facts.filter(fact => fact.target === 'guards.hosted_db_hosts')).toHaveLength(1)
    })

    it('reports an unreadable input instead of dropping it', async () => {
        const root = estate({ '.github/workflows/ci.yml': 'jobs: [unclosed', 'api/real.txt': 'x' })
        symlinkSync(join(root, 'api/real.txt'), join(root, 'api/Dockerfile'))
        writeFileSync(join(root, 'api/.env.example'), Buffer.from([0xc3, 0x28]))
        const { facts, skipped } = await deriveInferredFacts({ root, repositories: api })
        // Only the observed repository's own row is proposed; nothing comes from the unreadable files.
        expect(facts.map(fact => fact.target)).toEqual(['sibling.api'])
        expect(skipped).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: '.github/workflows/ci.yml', reason: expect.stringContaining('not valid YAML') }),
            expect.objectContaining({ source: 'api/Dockerfile', reason: 'is not a regular file' }),
            expect.objectContaining({ source: 'api/.env.example', reason: 'is not valid UTF-8' }),
        ]))
    })
})
