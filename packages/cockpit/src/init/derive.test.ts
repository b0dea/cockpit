import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composeFindings, deriveInferredFacts } from './derive.js'
import { Sibling, Testing } from '../schema.js'

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
const byTarget = <T extends { target: string }>(facts: readonly T[], target: string) => facts.find(fact => fact.target === target)

describe('inferred interview answers', () => {
    it('reads the final Dockerfile stage for the run command and exposed ports, naming the file', async () => {
        const root = estate({ 'api/Dockerfile': [
            'FROM node:22 AS build', 'EXPOSE 9999', 'CMD ["node", "build.mjs"]', 'HEALTHCHECK CMD ["true"]',
            'FROM node:22-slim', 'ENTRYPOINT ["node"]', 'CMD ["server.mjs"]', 'EXPOSE 3000/tcp 8080',
            'HEALTHCHECK --interval=10s --start-period=1m30s \\', '  CMD wget -qO- http://localhost:3000/healthz || exit 1', ''].join('\n') })
        const { facts } = await deriveInferredFacts({ root, repositories: api })
        expect(byTarget(facts, 'api.command')).toMatchObject({ value: ['node', 'server.mjs'],
            provenance: { kind: 'inferred', source: 'api/Dockerfile' } })
        expect(byTarget(facts, 'api.container_ports')).toMatchObject({ value: [3000, 8080],
            provenance: { kind: 'inferred', source: 'api/Dockerfile' } })
    })

    it('proposes the package manager\'s run of a start, serve or dev script only when no Dockerfile sets the command', async () => {
        const root = estate({ 'api/package.json': JSON.stringify({ scripts: { dev: 'vite', start: 'node index.js', serve: ' ' } }), 'api/yarn.lock': '' })
        const { facts } = await deriveInferredFacts({ root, repositories: api })
        expect(byTarget(facts, 'api.command')).toEqual({ fields: ['estate.runnable', 'environment.compose_files'], target: 'api.command',
            value: ['yarn', 'run', 'start'], provenance: { kind: 'inferred', source: 'api/package.json',
                reason: expect.stringMatching(/start script.*yarn\.lock selects yarn; dev is also declared/) } })
        const imaged = estate({ 'api/package.json': JSON.stringify({ scripts: { start: 'node index.js' } }), 'api/Dockerfile': 'FROM node:22\nCMD ["node", "server.mjs"]\n' })
        const fromImage = await deriveInferredFacts({ root: imaged, repositories: api })
        expect(fromImage.facts.filter(fact => fact.target === 'api.command')).toEqual([expect.objectContaining({ value: ['node', 'server.mjs'] })])
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
            provenance: { kind: 'derived', source: 'api/compose.yml' } })
        expect(byTarget(facts, 'services.postgres')).toMatchObject({ value: { image: 'postgres:16' },
            provenance: { source: '.github/workflows/ci.yml' } })
        expect(byTarget(facts, 'services.cache')).toMatchObject({ value: { image: 'redis:7' } })
    })

    it('derives the port map and the memory and CPU floor from one Compose file, naming each line, and asks when two limits disagree', async () => {
        const root = estate({ 'compose.yml': ['services:', '  web:', '    image: synthetic.invalid/web:1',
            '    ports: ["${WEB_PORT:-3000}:3000"]', '    deploy:', '      replicas: 2',
            '      resources: { limits: { memory: 512M, cpus: "0.5" } }',
            '  db:', '    image: synthetic.invalid/db:1', '    mem_limit: 1g', '    cpus: 1.25',
            // A service behind a profile does not start by default, so its limits are not part of the floor.
            '  debug:', '    image: synthetic.invalid/debug:1', '    profiles: [debug]', '    mem_limit: 64g', ''].join('\n') })
        const { facts } = await deriveInferredFacts({ root, repositories: [] })
        expect(byTarget(facts, 'ports.bases')).toMatchObject({ value: { WEB_PORT: 3000 }, provenance: { kind: 'derived', source: 'compose.yml:4' } })
        expect(byTarget(facts, 'environment.machine.runtime_memory_mb')).toMatchObject({ fields: ['environment.machine'], value: 2048,
            provenance: { kind: 'derived', source: 'compose.yml:7, compose.yml:10', reason: expect.stringContaining('web 512M x2, db 1g') } })
        expect(byTarget(facts, 'environment.machine.runtime_cpus')).toMatchObject({ value: 2.25,
            provenance: { kind: 'derived', source: 'compose.yml:7, compose.yml:11' } })

        // Two spellings of one limit that disagree are reported, not guessed between; a service with
        // no CPU limit leaves the CPUs unrecorded.
        const disagreeing = estate({ 'compose.yml': 'services:\n  db:\n    image: synthetic.invalid/db:1\n    mem_limit: 1g\n    deploy: { resources: { limits: { memory: 2g } } }\n' })
        const conflicted = await deriveInferredFacts({ root: disagreeing, repositories: [] })
        expect(conflicted.facts.filter(fact => fact.target.startsWith('environment.machine.'))).toEqual([])
        expect(conflicted.skipped).toContainEqual({ source: 'compose.yml:5', reason: expect.stringContaining('service db sets its memory limit twice') })
    })

    it('proposes no compose_files when Compose files sit in several repositories, and points at a cockpit-root compose.yml', async () => {
        // compose-first resolves every relative path against the first listed file's directory, so
        // listing both files would run the second one's ./ paths against the first repository.
        const root = estate({ 'api/compose.yml': 'services:\n  api:\n    build: .\n', 'web/compose.yml': 'services:\n  web:\n    build: .\n' })
        const { facts, skipped } = await deriveInferredFacts({ root, repositories: [...api, { slug: 'web', path: 'web' }] })
        expect(byTarget(facts, 'environment.compose_files')).toBeUndefined()
        expect(skipped).toContainEqual({ source: 'api/compose.yml, web/compose.yml', reason: expect.stringMatching(
            /resolves every relative path against the first listed file's directory.*compose\.yml at the cockpit root.*\$\{API_DIR\}/) })
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

    it('proposes the product repository a dedicated cockpit sits beside as its sibling, cloned from its origin remote', async () => {
        const parent = estate({ 'shop/package.json': '{}\n', 'shop/.git/config': [
            '[core]', '\tbare = false', '[remote "upstream"]', '\turl = git@example.invalid:fork/shop.git',
            '[remote "origin"]', '\turl = git@example.invalid:team/shop.git', '\tfetch = +refs/heads/*:refs/remotes/origin/*', ''].join('\n') })
        mkdirSync(join(parent, 'shop-cockpit'))
        const proposed = async () => (await deriveInferredFacts({ root: parent, configurationRoot: join(parent, 'shop-cockpit'),
            repositories: [{ slug: 'shop', path: 'shop' }] }))
        const { facts } = await proposed()
        expect(facts.filter(fact => fact.fields.includes('sibling'))).toEqual([{ fields: ['sibling'], target: 'sibling.shop',
            value: { slug: 'shop', dir: 'shop', remote: 'git@example.invalid:team/shop.git', mount: 'always', acquire: 'auto', var: 'SHOP_DIR' },
            provenance: expect.objectContaining({ kind: 'inferred', source: '../shop/.git/config' }) }])
        expect(Sibling.safeParse({ ...byTarget(facts, 'sibling.shop')!.value as object, purpose: 'storefront' }).success).toBe(true)

        // A token in the URL is never proposed or echoed; the repository stays acquire "none" and says why.
        writeFileSync(join(parent, 'shop/.git/config'), '[remote "origin"]\n\turl = https://deploy:synthetic-secret@example.invalid/team/shop.git\n')
        const credentialed = await proposed()
        expect(byTarget(credentialed.facts, 'sibling.shop')).toMatchObject({ value: { acquire: 'none' },
            provenance: { reason: expect.stringContaining('carries credentials') } })
        expect(byTarget(credentialed.facts, 'sibling.shop')!.value).not.toHaveProperty('remote')
        expect(credentialed.skipped).toContainEqual({ source: '../shop/.git/config', reason: expect.stringContaining('carries credentials') })
        expect(JSON.stringify(credentialed)).not.toContain('synthetic-secret')

        // A local path has no repository identity for preflight to compare, so proposing it made every preflight refuse.
        writeFileSync(join(parent, 'shop/.git/config'), '[remote "origin"]\n\turl = /srv/remotes/shop.git\n')
        const local = byTarget((await proposed()).facts, 'sibling.shop')!
        expect(local).toMatchObject({ value: { acquire: 'none' },
            provenance: { reason: expect.stringContaining('(/srv/remotes/shop.git) is not an https or ssh repository URL') } })
        expect(local.value).not.toHaveProperty('remote')

        writeFileSync(join(parent, 'shop/.git/config'), '[remote "upstream"]\n\turl = git@example.invalid:fork/shop.git\n')
        expect(byTarget((await proposed()).facts, 'sibling.shop')).toMatchObject({ value: { acquire: 'none' },
            provenance: { source: '../shop', reason: expect.stringContaining('../shop/.git/config names no origin remote') } })

        // A worktree or submodule checkout points at its Git directory from a .git file, which is not followed.
        rmSync(join(parent, 'shop/.git'), { recursive: true })
        writeFileSync(join(parent, 'shop/.git'), 'gitdir: ../elsewhere/.git\n')
        const pointer = await proposed()
        expect(byTarget(pointer.facts, 'sibling.shop')).toMatchObject({ value: { acquire: 'none' } })
        expect(pointer.skipped).toContainEqual({ source: '../shop/.git', reason: expect.stringContaining('is a file (a worktree or submodule pointer)') })
    })

    it('reads an in-repo cockpit\'s root once, as the repository at "." that is its own first sibling', async () => {
        const parent = estate({ 'shop/Dockerfile': 'FROM node:22\nEXPOSE 3000\nCMD ["node", "server.mjs"]\n',
            'shop/.env.example': 'DATABASE_URL=\n' })
        const { facts } = await deriveInferredFacts({ root: join(parent, 'shop'), repositories: [{ slug: 'shop', path: '.' }] })
        expect(byTarget(facts, 'shop.command')).toMatchObject({ value: ['node', 'server.mjs'], provenance: { source: 'Dockerfile' } })
        expect(byTarget(facts, 'sibling.shop')).toMatchObject({ value: { slug: 'shop', dir: '.' } })
        expect(facts.filter(fact => fact.target === 'guards.hosted_db_hosts')).toHaveLength(1)
    })

    // check refuses a mount = "none" sibling a service binds, and a published port no [ports.bases]
    // variable leases, so the proposal reads both from the Compose file it proposes.
    it('proposes mounting the in-repo sibling a proposed Compose file binds, and its host-port variables as bases', async () => {
        const parent = estate({ 'shop/api/server.mjs': '', 'shop/compose.yml': [
            'services:',
            '  api:',
            '    build: ./api',
            '    ports: ["127.0.0.1:${API_HOST_PORT:-4200}:3000", { target: 9229, published: "${DEBUG_HOST_PORT:-9229}" }]',
            '    volumes: ["./api:/app", "cache:/cache"]',
            '  web:',
            '    image: synthetic.invalid/web:1',
            '    ports: ["${WEB_HOST_PORT}:80", "8080:8080", { target: 81, published: 8081 }, "9000"]',
            'volumes: { cache: {} }', ''].join('\n') })
        const root = join(parent, 'shop')
        const { facts, skipped } = await deriveInferredFacts({ root, repositories: [{ slug: 'shop', path: '.' }] })
        expect(byTarget(facts, 'sibling.shop')).toMatchObject({ value: { dir: '.', mount: 'always' },
            provenance: { reason: expect.stringContaining('compose.yml bind-mounts') } })
        expect(byTarget(facts, 'ports.bases')).toEqual({ fields: ['ports.bases'], target: 'ports.bases',
            value: { API_HOST_PORT: 4200, DEBUG_HOST_PORT: 9229 },
            // WEB_HOST_PORT has no default, so the map is incomplete: a hint, not an answer the agent may accept.
            provenance: expect.objectContaining({ kind: 'inferred', source: 'compose.yml:4' }) })
        expect(skipped).toContainEqual({ source: 'compose.yml',
            reason: expect.stringContaining('publishes a host port from ${WEB_HOST_PORT} with no default') })
        // A literal host port is the same port in every stack; a container-only port gets an ephemeral one.
        expect(skipped.filter(row => row.reason.includes('not read from a variable')).map(row => row.reason.split(' that ')[0])).toEqual([
            'publishes host port 8080', 'publishes host port 8081'])

        // Bases read from several Compose files name each file and the variables it publishes.
        const several = estate({ 'api/compose.yml': 'services:\n  api:\n    ports: ["${API_PORT:-3000}:3000", "${DB_PORT:-5432}:5432"]\n',
            'web/compose.yml': 'services:\n  web:\n    ports: ["${WEB_PORT:-4000}:80", "${API_PORT:-3000}:3000", "${DB_PORT:-5433}:5432"]\n' })
        const merged = await deriveInferredFacts({ root: several, repositories: [{ slug: 'api', path: 'api' }, { slug: 'web', path: 'web' }] })
        expect(byTarget(merged.facts, 'ports.bases')).toMatchObject({ value: { API_PORT: 3000, WEB_PORT: 4000 },
            provenance: { kind: 'inferred', source: 'api/compose.yml:3, web/compose.yml:3',
                reason: expect.stringMatching(/^api\/compose\.yml publishes API_PORT; web\/compose\.yml publishes API_PORT, WEB_PORT from variables/) } })
        expect(merged.skipped).toContainEqual({ source: 'api/compose.yml, web/compose.yml',
            reason: expect.stringContaining('publishes ${DB_PORT} with different defaults') })

        // Binding only a named volume, or a directory outside the repository, does not mount it.
        const unmounted = estate({ 'shop/compose.yml': 'services:\n  db:\n    image: synthetic.invalid/db:1\n    volumes: ["data:/var/lib/db", "../elsewhere:/x"]\n' })
        const proposed = await deriveInferredFacts({ root: join(unmounted, 'shop'), repositories: [{ slug: 'shop', path: '.' }] })
        expect(byTarget(proposed.facts, 'sibling.shop')).toMatchObject({ value: { mount: 'none' } })
        // A Compose file that publishes no host port is read as needing no base port.
        expect(byTarget(proposed.facts, 'ports.bases')).toMatchObject({ value: {}, provenance: { kind: 'derived', source: 'compose.yml' } })

        // A Compose file in another repository names `.` relative to that repository, not the root.
        const beside = estate({ 'shop/api/compose.yml': 'services:\n  api:\n    build: .\n    volumes: [".:/app"]\n' })
        const besideFacts = await deriveInferredFacts({ root: join(beside, 'shop'),
            repositories: [{ slug: 'shop', path: '.' }, { slug: 'api', path: 'api' }] })
        expect(byTarget(besideFacts.facts, 'environment.compose_files')).toMatchObject({ value: ['api/compose.yml'] })
        expect(byTarget(besideFacts.facts, 'sibling.shop')).toMatchObject({ value: { mount: 'none' } })
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

    it('proposes a test script as both gates, run by the lockfile package manager from the cockpit root', async () => {
        const root = estate({ 'api/package.json': JSON.stringify({ scripts: { test: 'vitest run', 'test:e2e': 'playwright test' } }), 'api/pnpm-lock.yaml': '' })
        const { facts } = await deriveInferredFacts({ root, repositories: api })
        const stage = { id: 'test-api', command: ['sh', '-c', 'cd api && exec pnpm test'], requires_stack: false }
        expect(byTarget(facts, 'testing.api')).toEqual({ fields: ['testing'], target: 'testing.api', value: { stages: [stage], gates: [
            { id: 'targeted-api', tier: 'targeted', stages: ['test-api'], changes: 'Isolated behavior in api' },
            { id: 'full-api', tier: 'full', stages: ['test-api'], changes: 'Shared or cross-system behavior in api' },
        ] }, provenance: { kind: 'inferred', source: 'api/package.json', reason: expect.stringMatching(
            /pnpm-lock\.yaml selects pnpm.*targeted gate runs the same command.*test:e2e are not proposed.*requires_stack is false/) } })
        // The same lockfile proposes the node toolchain, naming the install policy row setup then needs.
        expect(byTarget(facts, 'api.toolchain')).toEqual({ fields: ['sibling', 'environment.install_policies'], target: 'api.toolchain',
            value: 'node', provenance: { kind: 'inferred', source: 'api/pnpm-lock.yaml',
                reason: expect.stringMatching(/toolchain "node" and lockfile "pnpm-lock\.yaml".*INSTALL_POLICY_MISSING/) } })
    })

    it('proposes the affected run of a build tool as the targeted gate', async () => {
        const root = estate({ 'api/nx.json': '{}', 'api/package.json': JSON.stringify({ scripts: { test: 'nx run-many -t test' } }) })
        const { facts } = await deriveInferredFacts({ root, repositories: api })
        expect(byTarget(facts, 'testing.api')).toMatchObject({ value: {
            stages: [{ id: 'affected-api', command: ['sh', '-c', 'cd api && exec npx --no nx affected -t test'] },
                { id: 'test-api', command: ['sh', '-c', 'cd api && exec npx --no nx run-many -t test'] }],
            gates: [{ id: 'targeted-api', stages: ['affected-api'], changes: 'Isolated behavior in api; Nx selects the affected tests' },
                { id: 'full-api', stages: ['test-api'] }],
        }, provenance: { source: 'api/nx.json', reason: expect.stringContaining('defaultBase') } })
    })

    // Sibling slugs may start with a digit and run long; [testing] ids may not, so a proposal the
    // schema would reject after acceptance is never made.
    it('proposes only [testing] ids the schema accepts, and says why when a slug cannot form one', async () => {
        const long = `a${'b'.repeat(59)}`
        const root = estate({ '3d-viewer/Makefile': 'test:\n\ttrue\n', [`${long}/Makefile`]: 'test:\n\ttrue\n' })
        const { facts, skipped } = await deriveInferredFacts({ root, repositories: [{ slug: '3d-viewer', path: '3d-viewer' }, { slug: long, path: long }] })
        const proposed = byTarget(facts, 'testing.3d-viewer')?.value as { stages: unknown[]; gates: unknown[] }
        expect(Testing.safeParse({ ...proposed, native_hooks: {} }).success).toBe(true)
        expect(proposed.gates).toMatchObject([{ id: 'targeted-3d-viewer', stages: ['test-3d-viewer'] }, { id: 'full-3d-viewer' }])
        expect(byTarget(facts, `testing.${long}`)).toBeUndefined()
        expect(skipped).toContainEqual({ source: `${long}/Makefile`, reason: expect.stringMatching(
            new RegExp(`^Makefile has a test entry point, but the \\[testing\\] id test-${long} formed from the slug ${long} is not .* at most 64 characters`)) })
    })

    it('proposes no gate and names what it looked for when a repository has no test entry point', async () => {
        // npm init writes a test script that only fails; declaring it would make every gate FAIL.
        const root = estate({ 'api/package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })
        const result = await deriveInferredFacts({ root, repositories: api })
        expect(result.facts.filter(fact => fact.fields.includes('testing'))).toEqual([])
        expect(result.skipped).toContainEqual({ source: 'api', reason: expect.stringMatching(
            /^no test entry point was found, so no \[testing\] gate is proposed for api; looked for MODULE\.bazel.*package\.json test script.*Cargo\.toml$/) })
    })
})

describe('Compose findings for a drafted cockpit.toml', () => {
    it('reports check\'s port, container name and healthcheck findings with its fix, and nothing for a leased, healthy service', async () => {
        const root = estate({ 'compose.yml': [
            'services:',
            '  web:', '    image: synthetic.invalid/web:1', '    ports: ["127.0.0.1:3000:3000"]',
            '  api:', '    image: synthetic.invalid/api:1', '    ports: ["127.0.0.1:${API_HOST_PORT:-4200}:4200"]',
            '    healthcheck: { test: ["CMD", "true"] }',
            '  db:', '    image: synthetic.invalid/db:1', '    container_name: fixed-db', '    healthcheck: { test: ["CMD", "true"] }',
            '  app:', '    build: .', '    image: my-app:dev', '    healthcheck: { test: ["CMD", "true"] }', ''].join('\n') })
        const draft = (bases: string) => `[environment]\ncompose_files = ["compose.yml"]\n[ports.bases]\n${bases}\n`
        const found = await composeFindings({ root, draft: draft('API_HOST_PORT = 4200') })
        expect(found).toEqual([
            expect.objectContaining({ severity: 'warning', code: 'COMPOSE_PORT_NOT_LEASED', target: 'compose:web:3000',
                fix: 'publish it as "${WEB_HOST_PORT}:3000" in the Compose file and declare WEB_HOST_PORT under [ports.bases]' }),
            expect.objectContaining({ severity: 'warning', code: 'COMPOSE_HEALTHCHECK_MISSING', target: 'compose:web' }),
            expect.objectContaining({ severity: 'warning', code: 'COMPOSE_CONTAINER_NAME_FIXED', target: 'compose:db',
                fix: 'remove container_name from service db and address it by its Compose service name, or with docker compose exec db' }),
            expect.objectContaining({ severity: 'warning', code: 'COMPOSE_IMAGE_TAG_SHARED', target: 'compose:app',
                fix: 'remove image from service app, so Compose names the build after this stack\'s project' })])
        // The same file is unleased for api until its variable is declared.
        expect((await composeFindings({ root, draft: draft('') })).map(row => row.target)).toContain('compose:api:4200')
        // A draft that declares no Compose file has none to judge.
        expect(await composeFindings({ root, draft: '[environment]\ncompose_files = []\n' })).toEqual([])
        // A declared file that cannot be read is said, not skipped.
        expect(await composeFindings({ root, draft: '[environment]\ncompose_files = ["missing.yml"]\n' })).toEqual([
            expect.objectContaining({ code: 'COMPOSE_FILE_UNREADABLE', target: 'missing.yml' })])
    })
})
