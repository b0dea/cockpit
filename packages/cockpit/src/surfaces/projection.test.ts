import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const fsFault = vi.hoisted(() => ({
    path: undefined as string | undefined,
    stage: undefined as 'read' | 'close' | undefined,
    afterRead: undefined as (() => Promise<void>) | undefined,
    afterRealpathPath: undefined as string | undefined,
    afterRealpath: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        realpath: async (path: string) => {
            const resolved = await actual.realpath(path)
            if (path === fsFault.afterRealpathPath) {
                const mutate = fsFault.afterRealpath
                fsFault.afterRealpathPath = undefined
                fsFault.afterRealpath = undefined
                await mutate?.()
            }
            return resolved
        },
        open: async (path: string, flags: string) => {
            const handle = await actual.open(path, flags)
            if (path !== fsFault.path) return handle
            return new Proxy(handle, {
                get(target, property) {
                    if (property === 'read') return async (...args: Parameters<typeof target.read>) => {
                        if (fsFault.stage === 'read') throw new Error('injected read failure')
                        const result = await target.read(...args)
                        const mutate = fsFault.afterRead
                        fsFault.afterRead = undefined
                        await mutate?.()
                        return result
                    }
                    if (property === 'close') return async () => {
                        await target.close()
                        if (fsFault.stage === 'close') throw new Error('injected close failure')
                    }
                    const value = Reflect.get(target, property, target) as unknown
                    return typeof value === 'function' ? value.bind(target) : value
                },
            })
        },
    }
})

import {
    observeSiblingGuides,
    planSiblingProjection,
    shippedInstructionCapabilities,
    type ProjectionPlannerInput,
} from './projection.js'
import { SURFACE_TARGETS } from './harness-registry.js'

const roots: string[] = []

afterEach(async () => {
    fsFault.path = undefined
    fsFault.stage = undefined
    fsFault.afterRead = undefined
    fsFault.afterRealpathPath = undefined
    fsFault.afterRealpath = undefined
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-projection-'))
    roots.push(root)
    const main = join(root, 'estate', 'cockpit')
    const api = join(root, 'estate', 'api')
    const mobile = join(root, 'estate', 'mobile')
    const docs = join(root, 'estate', 'docs')
    const data = join(root, 'estate', 'data')
    await Promise.all([main, api, mobile, docs, data].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(api, 'CLAUDE.md'), 'shared guide\nsecond line\n')
    await symlink('CLAUDE.md', join(api, 'AGENTS.md'))
    await writeFile(join(mobile, 'AGENTS.md'), 'mobile guide\n')
    await writeFile(join(docs, 'AGENTS.md'), 'docs guide\n')
    await writeFile(join(data, 'AGENTS.md'), 'data guide\n')
    return { root, main, api, mobile, docs, data }
}

const characterizations = {
    claudecode: {
        measuredOn: '2026-09-26',
        provenance: 'paired source-estate rule-loading measurement',
        metric: 'lines' as const,
        scopeSemantics: 'conditional' as const,
    },
    codexcli: {
        measuredOn: '2026-09-26',
        provenance: 'root AGENTS loading measurement',
        metric: 'lines' as const,
        scopeSemantics: 'full' as const,
    },
    opencode: {
        measuredOn: '2026-09-26',
        provenance: 'instructions-list loading measurement',
        metric: 'lines' as const,
        scopeSemantics: 'full' as const,
    },
}

async function validInput(options: { override?: string } = {}): Promise<ProjectionPlannerInput> {
    const paths = await fixture()
    const resolvedApi = options.override ?? paths.api
    const observations = await observeSiblingGuides({
        allowedRoots: [resolvedApi],
        requests: [
            { slug: 'api', root: resolvedApi, sourcePath: join(resolvedApi, 'CLAUDE.md') },
            { slug: 'api', root: resolvedApi, sourcePath: join(resolvedApi, 'AGENTS.md') },
        ],
    })
    if (observations.kind !== 'complete') throw new Error(`fixture guide observation failed: ${JSON.stringify(observations)}`)
    return {
        canonicalMainCheckout: paths.main,
        siblingsRoot: '..',
        activeProfiles: ['app'],
        guideCapLines: 20,
        siblings: [
            {
                slug: 'api',
                mount: 'always',
                directoryAuthority: 'api',
                ...(options.override ? { declaredOverride: options.override } : {}),
                guides: ['CLAUDE.md', 'AGENTS.md'],
            },
            { slug: 'mobile', mount: 'profile:mobile', directoryAuthority: 'mobile' },
            { slug: 'docs', mount: 'host', directoryAuthority: 'docs' },
            { slug: 'data', mount: 'none', directoryAuthority: 'data' },
        ],
        mountedPaths: [{ slug: 'api', path: resolvedApi }],
        directoryGrants: [
            { slug: 'api', target: 'claudecode', path: resolvedApi },
            { slug: 'api', target: 'codexcli', path: resolvedApi },
            { slug: 'api', target: 'opencode', path: resolvedApi },
            { slug: 'api', target: 'cursor', path: resolvedApi },
            { slug: 'api', target: 'grokcli', path: resolvedApi },
        ],
        guideObservations: observations.observations,
        existingEntries: [],
        priorOwnedLinks: [],
        standingSources: [
            { target: 'claudecode', path: '.claude/rules/scoped.md', content: 'one\ntwo\nthree\n', scope: 'scoped' },
            { target: 'codexcli', path: 'AGENTS.md#rules', content: 'one\ntwo\nthree\n', scope: 'scoped' },
            { target: 'opencode', path: 'rules/scoped.md', content: 'one\ntwo\nthree\n', scope: 'scoped' },
        ],
        loadCharacterizations: characterizations,
    }
}

describe('live sibling projection planner', () => {
    it('issues the exact frozen instruction facts consumed by native projection', async () => {
        const capabilities = shippedInstructionCapabilities()
        expect(capabilities).toEqual([
            { target: 'claudecode', mechanism: 'claude-relative-import', capability: 'instructed', evidence: 'pending_evidence', characterizedOn: '2026-09-26', provenance: 'source setup projection header and in-tree relative import measurement' },
            { target: 'codexcli', mechanism: 'codex-root-instruction', capability: 'instructed', evidence: 'pending_evidence', characterizedOn: '2026-09-26', provenance: 'Codex reads root AGENTS.md; native file-import syntax remains unavailable' },
            { target: 'opencode', mechanism: 'opencode-instructions', capability: 'instructed', evidence: 'pending_evidence', characterizedOn: '2026-09-26', provenance: 'source instructions-list loading measurement' },
            { target: 'cursor', mechanism: 'rulesync-rules', capability: 'generated', evidence: 'pending_evidence', characterizedOn: '2026-10-28', provenance: 'cockpit generates this file; no paired candidate and broken-control probe has verified that the tool loads it' },
            { target: 'grokcli', mechanism: 'rulesync-rules', capability: 'generated', evidence: 'pending_evidence', characterizedOn: '2026-10-28', provenance: 'cockpit generates this file; no paired candidate and broken-control probe has verified that the tool loads it' },
        ])
        expect(Object.isFrozen(capabilities)).toBe(true)
        expect(capabilities.every(Object.isFrozen)).toBe(true)

        const result = planSiblingProjection(await validInput())
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        for (const capability of capabilities.filter(row => row.capability === 'instructed')) {
            const native = result.native.find(row => row.target === capability.target)!
            expect(native).toMatchObject({
                mechanism: capability.mechanism,
                capability: capability.capability,
                evidence: capability.evidence,
                characterizedOn: capability.characterizedOn,
                provenance: capability.provenance,
            })
        }
    })

    it('projects one active sibling through all native harness spellings', async () => {
        const input = await validInput()
        const result = planSiblingProjection(input)

        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        expect(result.links).toHaveLength(1)
        expect(result.links[0]).toMatchObject({
            path: '.sibling-api-CLAUDE.md',
            sourceGuidePath: resolve(input.canonicalMainCheckout, '..', 'api', 'CLAUDE.md'),
            sourceEntryType: 'file',
            ownership: 'whole-file',
        })
        expect(result.links[0]!.target).toBe(relative(input.canonicalMainCheckout, result.links[0]!.sourceGuidePath))
        expect(result.native).toEqual([
            expect.objectContaining({ target: 'claudecode', path: 'CLAUDE.local.md', spelling: '@./.sibling-api-CLAUDE.md', ownership: 'shared-region', capability: 'instructed', evidence: 'pending_evidence' }),
            expect.objectContaining({ target: 'codexcli', path: 'AGENTS.md', spelling: 'Read ./.sibling-api-CLAUDE.md before editing api.', ownership: 'shared-region', capability: 'instructed', evidence: 'pending_evidence' }),
            expect.objectContaining({ target: 'opencode', path: 'opencode.jsonc', spelling: '.sibling-api-CLAUDE.md', ownership: 'shared-region', capability: 'instructed', evidence: 'pending_evidence' }),
        ])
        expect(result.grants.map(grant => [grant.target, grant.spelling])).toEqual([
            ['claudecode', 'permissions.additionalDirectories:../api'],
            ['codexcli', 'sandbox_workspace_write.writable_roots:../api'],
            ['opencode', 'permission.external_directory:../api/**=allow'],
            ['cursor', 'permission.read+write:../api/**=allow'],
            ['grokcli', 'permission.read+edit:../api/**=allow'],
        ])
        expect(result.links.every(link => !link.sourceGuidePath.includes('mobile') && !link.sourceGuidePath.includes('docs') && !link.sourceGuidePath.includes('data'))).toBe(true)
        expect(Object.isFrozen(result)).toBe(true)
        expect(Object.isFrozen(result.native)).toBe(true)
    })

    it('uses canonical main authority in a nested worktree and lets an explicit override win', async () => {
        const first = await validInput()
        const nestedCwd = join(first.canonicalMainCheckout, '.worktrees', 'nested', 'deeper')
        const firstResult = planSiblingProjection({ ...first, invocationCwd: nestedCwd })
        expect(firstResult).toMatchObject({ kind: 'complete', links: [{ sourceGuidePath: resolve(first.canonicalMainCheckout, '..', 'api', 'CLAUDE.md') }] })

        const overrideRoot = await mkdtemp(join(tmpdir(), 'cockpit-projection-override-'))
        roots.push(overrideRoot)
        await writeFile(join(overrideRoot, 'CLAUDE.md'), 'override guide\n')
        await writeFile(join(overrideRoot, 'AGENTS.md'), 'override guide\n')
        const overridden = await validInput({ override: overrideRoot })
        const overrideResult = planSiblingProjection(overridden)
        expect(overrideResult).toMatchObject({ kind: 'complete', links: [{ sourceGuidePath: join(overrideRoot, 'CLAUDE.md') }] })
    })

    it('keeps a configured live guide symlink as the projection source', async () => {
        const input = await validInput()
        input.siblings[0]!.guides = ['AGENTS.md', 'CLAUDE.md']
        const result = planSiblingProjection(input)
        expect(result).toMatchObject({
            kind: 'complete',
            links: [{
                path: '.sibling-api-AGENTS.md',
                sourceGuidePath: resolve(input.canonicalMainCheckout, '..', 'api', 'AGENTS.md'),
                sourceEntryType: 'symlink',
                sourceLinkTarget: 'CLAUDE.md',
            }],
        })
    })

    it('selects a profile sibling only when that exact profile is active', async () => {
        const input = await validInput()
        const mobile = resolve(input.canonicalMainCheckout, '..', 'mobile')
        const observed = await observeSiblingGuides({
            allowedRoots: [mobile],
            requests: [{ slug: 'mobile', root: mobile, sourcePath: join(mobile, 'AGENTS.md') }],
        })
        if (observed.kind !== 'complete') throw new Error(`profile guide observation failed: ${JSON.stringify(observed)}`)
        input.activeProfiles = ['mobile']
        input.mountedPaths.push({ slug: 'mobile', path: mobile })
        input.directoryGrants.push(...SURFACE_TARGETS.map(target => ({ slug: 'mobile', target, path: mobile })))
        input.guideObservations = [...input.guideObservations, ...observed.observations]

        const result = planSiblingProjection(input)
        expect(result.kind).toBe('complete')
        if (result.kind === 'complete') {
            expect(result.links).toEqual(expect.arrayContaining([
                expect.objectContaining({ sibling: 'mobile', path: '.sibling-mobile-AGENTS.md' }),
            ]))
        }
    })

    it('refuses a guide symlink that escapes its declared sibling root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-projection-escape-'))
        roots.push(root)
        const sibling = join(root, 'sibling')
        await mkdir(sibling)
        await writeFile(join(root, 'outside.md'), 'outside\n')
        await symlink('../outside.md', join(sibling, 'AGENTS.md'))

        expect(await observeSiblingGuides({
            allowedRoots: [sibling],
            requests: [{ slug: 'api', root: sibling, sourcePath: join(sibling, 'AGENTS.md') }],
        })).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_GUIDE_ESCAPE' } })
    })

    it('refuses aggregate guide observations beyond the immutable snapshot bound', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-projection-aggregate-'))
        roots.push(root)
        const requests = await Promise.all(Array.from({ length: 256 }, async (_, index) => {
            const sourcePath = join(root, `guide-${index}.md`)
            await writeFile(sourcePath, 'x'.repeat(4096))
            return { slug: `s${index}`, root, sourcePath }
        }))

        const result = await observeSiblingGuides({ allowedRoots: [root], requests })
        expect(result).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_RESULT_BOUNDS' } })
        expect(result).not.toBeUndefined()
    })

    it.each(['symlink', 'file'] as const)('refuses a %s pathname replaced during the descriptor read', async entryType => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-projection-replacement-'))
        roots.push(root)
        const sourcePath = join(root, 'AGENTS.md')
        await writeFile(join(root, 'first.md'), 'first\n')
        await writeFile(join(root, 'second.md'), 'second\n')
        if (entryType === 'symlink') await symlink('first.md', sourcePath)
        else await writeFile(sourcePath, 'first\n')
        fsFault.path = sourcePath
        fsFault.afterRead = async () => {
            if (entryType === 'symlink') {
                await unlink(sourcePath)
                await symlink('second.md', sourcePath)
            } else {
                await rename(join(root, 'second.md'), sourcePath)
            }
        }

        expect(await observeSiblingGuides({
            allowedRoots: [root],
            requests: [{ slug: 'api', root, sourcePath }],
        })).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_GUIDE_CHANGED' } })
    })

    it.each(['read', 'close'] as const)('refuses an observed descriptor %s failure', async stage => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-projection-io-'))
        roots.push(root)
        const sourcePath = join(root, 'AGENTS.md')
        await writeFile(sourcePath, 'guide\n')
        fsFault.path = sourcePath
        fsFault.stage = stage

        expect(await observeSiblingGuides({
            allowedRoots: [root],
            requests: [{ slug: 'api', root, sourcePath }],
        })).toMatchObject({
            kind: 'refusal',
            diagnostic: { code: stage === 'read' ? 'PROJECTION_GUIDE_READ_FAILED' : 'PROJECTION_GUIDE_CLOSE_FAILED' },
        })
    })

    it('binds overlapping roots to the most-specific declared authority regardless of ordering', async () => {
        const broad = await mkdtemp(join(tmpdir(), 'cockpit-projection-roots-'))
        roots.push(broad)
        const nested = join(broad, 'nested')
        const peer = join(broad, 'peer')
        await Promise.all([nested, peer].map(path => mkdir(path)))
        await writeFile(join(peer, 'AGENTS.md'), 'peer\n')
        const sourcePath = join(nested, 'AGENTS.md')
        await symlink('../peer/AGENTS.md', sourcePath)

        for (const allowedRoots of [[broad, nested], [nested, broad]]) {
            expect(await observeSiblingGuides({
                allowedRoots,
                requests: [{ slug: 'api', root: nested, sourcePath }],
            })).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_GUIDE_ESCAPE' } })
        }

        await unlink(sourcePath)
        await writeFile(sourcePath, 'nested\n')
        expect(await observeSiblingGuides({
            allowedRoots: [broad, nested],
            requests: [{ slug: 'api', root: nested, sourcePath }],
        })).toMatchObject({ kind: 'complete', observations: [{ content: 'nested\n' }] })

        const alias = join(broad, 'nested-alias')
        await symlink('nested', alias)
        expect(await observeSiblingGuides({
            allowedRoots: [nested, alias],
            requests: [{ slug: 'api', root: nested, sourcePath }],
        })).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_ROOT_AMBIGUOUS' } })
    })

    it('refuses a sibling root replaced after its canonical path is captured', async () => {
        const container = await mkdtemp(join(tmpdir(), 'cockpit-projection-root-swap-'))
        roots.push(container)
        const root = join(container, 'sibling')
        const replacement = join(container, 'replacement')
        const retired = join(container, 'retired')
        await Promise.all([root, replacement].map(path => mkdir(path)))
        await writeFile(join(root, 'AGENTS.md'), 'original\n')
        await writeFile(join(replacement, 'AGENTS.md'), 'replacement\n')
        const request = { slug: 'api', root, sourcePath: join(root, 'AGENTS.md') }

        expect(await observeSiblingGuides({ allowedRoots: [root], requests: [request] }))
            .toMatchObject({ kind: 'complete', observations: [{ content: 'original\n' }] })

        fsFault.afterRealpathPath = root
        fsFault.afterRealpath = async () => {
            await rename(root, retired)
            await rename(replacement, root)
        }
        expect(await observeSiblingGuides({ allowedRoots: [root], requests: [request] }))
            .toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_GUIDE_CHANGED' } })
    })

    it('reports target-only drift and only exact prior-owned stale links', async () => {
        const input = await validInput()
        input.existingEntries = [{ path: '.sibling-api-CLAUDE.md', type: 'symlink', target: '../wrong/CLAUDE.md' }]
        input.priorOwnedLinks = [
            { path: '.sibling-old-AGENTS.md', target: '../old/AGENTS.md' },
        ]
        input.existingEntries.push(
            { path: '.sibling-old-AGENTS.md', type: 'symlink', target: '../old/AGENTS.md' },
            { path: '.sibling-unmanaged-AGENTS.md', type: 'symlink', target: '../unmanaged/AGENTS.md' },
        )

        const result = planSiblingProjection(input)
        expect(result).toMatchObject({
            kind: 'complete',
            comparisons: [{ path: '.sibling-api-CLAUDE.md', state: 'drift', expectedType: 'symlink', actualType: 'symlink', expectedTarget: '../api/CLAUDE.md', actualTarget: '../wrong/CLAUDE.md' }],
            staleLinks: [{ path: '.sibling-old-AGENTS.md', target: '../old/AGENTS.md' }],
        })
        if (result.kind === 'complete') expect(result.staleLinks.some(link => link.path.includes('unmanaged'))).toBe(false)
    })

    it.each([
        ['generated mount', (input: ProjectionPlannerInput) => { input.mountedPaths[0] = { slug: 'api', path: '/wrong/mount' } }, 'PROJECTION_MOUNT_MISMATCH'],
        ['native grant', (input: ProjectionPlannerInput) => { input.directoryGrants[1] = { slug: 'api', target: 'codexcli', path: '/wrong/grant' } }, 'PROJECTION_GRANT_MISMATCH'],
    ])('refuses a wrong %s path with both exact values', async (_label, change, code) => {
        const input = await validInput()
        change(input)
        expect(planSiblingProjection(input)).toMatchObject({ kind: 'refusal', diagnostic: { code } })
        const result = planSiblingProjection(input)
        if (result.kind === 'refusal') {
            expect(result.diagnostic.expected).toBe(resolve(input.canonicalMainCheckout, '..', 'api'))
            expect(result.diagnostic.actual).toContain('/wrong/')
        }
    })

    it('accounts each harness with its own scoped semantics and cap', async () => {
        const input = await validInput()
        input.guideCapLines = 4
        const result = planSiblingProjection(input)
        expect(result).toMatchObject({
            kind: 'complete',
            costs: [
                { target: 'claudecode', status: 'within_cap', metric: 'lines', value: 2, conditionalValue: 3, cap: 4 },
                { target: 'codexcli', status: 'within_cap', metric: 'lines', value: 4, conditionalValue: 0, cap: 4 },
                { target: 'opencode', status: 'exceeded', metric: 'lines', value: 5, conditionalValue: 0, cap: 4 },
            ],
            headline: { metric: 'lines', value: 5, target: 'opencode' },
        })

        input.loadCharacterizations = { ...characterizations }
        delete input.loadCharacterizations.codexcli
        const unavailable = planSiblingProjection(input)
        expect(unavailable).toMatchObject({ kind: 'complete', costs: expect.arrayContaining([{ target: 'codexcli', status: 'unavailable', reason: 'load cost is not characterized' }]) })
    })

    it('refuses traversal, accessors, proxies, and oversized own data', async () => {
        const input = await validInput()
        input.siblings[0]!.guides = ['../AGENTS.md']
        expect(planSiblingProjection(input)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_INPUT_INVALID' } })

        let reads = 0
        const accessor = Object.defineProperty({}, 'canonicalMainCheckout', { enumerable: true, get: () => { reads += 1; return '/' } })
        expect(planSiblingProjection(accessor)).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_INPUT_INVALID' } })
        expect(planSiblingProjection(new Proxy({}, { get: () => { reads += 1; throw new Error('must not run') } }))).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_INPUT_INVALID' } })
        expect(planSiblingProjection({ ...input, standingSources: [{ target: 'codexcli', path: 'AGENTS.md', content: 'x'.repeat(65_537), scope: 'always' }] })).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_INPUT_INVALID' } })
        expect(reads).toBe(0)
    })

    it('refuses planner output amplification before immutable capture is exhausted', async () => {
        const input = await validInput()
        const template = input.guideObservations[0]!
        input.siblings = []
        input.mountedPaths = []
        input.directoryGrants = []
        const guideObservations: Array<ProjectionPlannerInput['guideObservations'][number]> = []
        input.guideObservations = guideObservations
        for (let index = 0; index < 100; index += 1) {
            const slug = `s${index}`
            const directoryAuthority = `${slug}-${'x'.repeat(1000)}`
            const path = resolve(input.canonicalMainCheckout, '..', directoryAuthority)
            input.siblings.push({ slug, mount: 'always', directoryAuthority, guides: ['AGENTS.md'] })
            input.mountedPaths.push({ slug, path })
            input.directoryGrants.push(...SURFACE_TARGETS.map(target => ({ slug, target, path })))
            guideObservations.push({ ...template, slug, sourcePath: join(path, 'AGENTS.md') })
        }

        const result = planSiblingProjection(input)
        expect(result).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_RESULT_BOUNDS' } })
        expect(result).not.toBeUndefined()
    })
})
