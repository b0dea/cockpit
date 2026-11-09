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
        standingSources: [
            { target: 'claudecode', path: '.claude/rules/scoped.md', content: 'one\ntwo\nthree\n', scope: 'scoped' },
            { target: 'codexcli', path: 'AGENTS.md#rules', content: 'one\ntwo\nthree\n', scope: 'scoped' },
            { target: 'opencode', path: 'rules/scoped.md', content: 'one\ntwo\nthree\n', scope: 'scoped' },
        ],
        loadCharacterizations: characterizations,
    }
}

describe('live sibling projection planner', () => {
    it('issues the exact instruction facts the capability matrix publishes', () => {
        const capabilities = shippedInstructionCapabilities()
        expect(capabilities).toEqual([
            { target: 'claudecode', mechanism: 'root-agents-guide', capability: 'instructed', evidence: 'not_applicable', characterizedOn: '2026-11-08', measuredVersion: '2.1.319',
                provenance: 'the generated CLAUDE.md import sent the exact AGENTS.md content, with generated standalone HTML comments removed by Claude, to an isolated loopback model; a replacement control changed the same native instruction block. Earlier sibling discovery: in a trusted workspace, as in an untrusted one, a sibling guide copied into the root AGENTS.md that CLAUDE.md imports loaded while the undeclared sibling\'s guides and the decoys did not; permissions.additionalDirectories with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD still loaded nothing, --add-dir with that variable loaded the sibling\'s CLAUDE.md but never its AGENTS.md, and a CLAUDE.md @-import loaded only once its external-include approval was set' },
            { target: 'codexcli', mechanism: 'root-agents-guide', capability: 'instructed', evidence: 'not_applicable', characterizedOn: '2026-11-03', measuredVersion: '0.166.0',
                provenance: 'a sibling guide copied into the root AGENTS.md loaded while the undeclared sibling\'s guide and the decoy did not; nothing loaded through a line in AGENTS.md telling the agent to read a link to the guide, through --add-dir naming the sibling, or through project_doc_fallback_filenames naming the link, and Codex dropped the end of a project AGENTS.md past 32 KiB' },
            { target: 'opencode', mechanism: 'root-agents-guide', capability: 'instructed', evidence: 'not_applicable', characterizedOn: '2026-11-03', measuredVersion: '1.19.5',
                provenance: 'a sibling guide copied into the root AGENTS.md loaded, as did a guide named through a link in the opencode.jsonc instructions list, while the undeclared sibling\'s guide and the decoy did not' },
            { target: 'cursor', mechanism: 'rulesync-rules', capability: 'generated', evidence: 'pending_evidence', characterizedOn: '2026-10-28', measuredVersion: null, provenance: 'cockpit\'s instructions and the sibling guides it copies reach Cursor only through the root AGENTS.md, and .cursor/rules holds only rules overlays; no run of the tool beside a broken control has shown that it loads either' },
            { target: 'grokcli', mechanism: 'rulesync-rules', capability: 'generated', evidence: 'pending_evidence', characterizedOn: '2026-10-28', measuredVersion: null, provenance: 'cockpit writes the files, but no run of the tool beside a broken control has shown that it loads them' },
        ])
    })

    it('copies an active sibling\'s guide once, labelled with its sibling and digest, and grants every harness its directory', async () => {
        const input = await validInput()
        const result = planSiblingProjection(input)

        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        // AGENTS.md links to CLAUDE.md, so the one text is copied once, under the first declared name.
        const sourceGuidePath = resolve(input.canonicalMainCheckout, '..', 'api', 'CLAUDE.md')
        const sha256 = input.guideObservations.find(row => row.sourcePath === sourceGuidePath)!.contentSha256
        expect(result.guides).toEqual([{
            sibling: 'api', guide: 'CLAUDE.md', sourceGuidePath, sourceContentIdentity: expect.any(String), sourceContentSha256: sha256,
            bytes: `\n## Instructions for sibling \`api\` (its CLAUDE.md)\n\n<!-- cockpit:sibling-guide sibling=api guide=CLAUDE.md sha256=${sha256} -->\n\nshared guide\nsecond line`,
        }])
        expect(result.grants.map(grant => [grant.target, grant.spelling])).toEqual([
            ['claudecode', 'permissions.additionalDirectories:../api'],
            ['codexcli', 'sandbox_workspace_write.writable_roots:../../api'],
            ['opencode', 'permission.external_directory:{file:.cockpit/local/opencode-grant-api}/**=allow'],
            ['cursor', 'permission.read+write:../api/**=allow'],
            ['grokcli', 'permission.read+edit:../api/**=allow'],
        ])
    })

    // A guide set up the way setup leaves it (AGENTS.md shared, CLAUDE.md importing it) must reach
    // every tool once, without the pointer back to this cockpit or an import that would name the
    // cockpit's own AGENTS.md from the root.
    it('copies a guide without the cockpit pointer block or an import of the sibling\'s own AGENTS.md, and refuses cockpit region markers', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-projection-text-'))
        roots.push(root)
        const main = join(root, 'cockpit')
        const api = join(root, 'api')
        await Promise.all([main, api].map(path => mkdir(path)))
        await writeFile(join(api, 'AGENTS.md'), '# API\n\nRun the tests.\n<!-- cockpit:instruction-pointer:start -->\nRead [the cockpit instructions](<../cockpit/AGENTS.md>) before editing this repository.\n<!-- cockpit:instruction-pointer:end -->\n')
        await writeFile(join(api, 'CLAUDE.md'), '@AGENTS.md\n\nUse the Bash tool for git.\n')
        const plan = async () => {
            const observed = await observeSiblingGuides({ allowedRoots: [api], requests: ['CLAUDE.md', 'AGENTS.md'].map(guide => ({ slug: 'api', root: api, sourcePath: join(api, guide) })) })
            if (observed.kind !== 'complete') throw new Error(`guide observation failed: ${JSON.stringify(observed)}`)
            return planSiblingProjection({
                canonicalMainCheckout: main, siblingsRoot: '..', activeProfiles: [], guideCapLines: 200,
                siblings: [{ slug: 'api', mount: 'always', directoryAuthority: 'api', guides: ['CLAUDE.md', 'AGENTS.md'] }],
                mountedPaths: [{ slug: 'api', path: api }], directoryGrants: SURFACE_TARGETS.map(target => ({ slug: 'api', target, path: api })),
                guideObservations: observed.observations, standingSources: [], loadCharacterizations: characterizations,
            })
        }

        const copied = await plan()
        expect(copied.kind).toBe('complete')
        if (copied.kind !== 'complete') return
        expect(copied.guides.map(guide => guide.bytes.split('\n\n').slice(2).join('\n\n'))).toEqual(['Use the Bash tool for git.', '# API\n\nRun the tests.'])

        // In the cockpit root a sibling's own import would name a file beside the cockpit, so the copy
        // points at the sibling's file by a plain path instead; prose mentions and code stay as written.
        // Only a token naming a file the sibling holds is an import; package names and handles stay as written.
        await mkdir(join(api, 'docs'))
        await writeFile(join(api, 'docs/architecture.md'), '# Architecture\n')
        await writeFile(join(api, 'CLAUDE.md'), '@AGENTS.md\n\nRead @docs/architecture.md first; ask @oncall or @jane.doe. Use @tanstack/react-query and @types/node. `@docs/example.md` is literal.\n')
        const pointed = await plan()
        expect(pointed.kind === 'complete' && pointed.guides[0]!.bytes.split('\n\n').slice(2).join('\n\n'))
            .toBe('Read `../api/docs/architecture.md` first; ask @oncall or @jane.doe. Use @tanstack/react-query and @types/node. `@docs/example.md` is literal.')

        await writeFile(join(api, 'CLAUDE.md'), '@AGENTS.md\n')
        const importOnly = await plan()
        expect(importOnly.kind === 'complete' && importOnly.guides.map(guide => guide.guide)).toEqual(['AGENTS.md'])

        await writeFile(join(api, 'AGENTS.md'), '# API\n<!-- cockpit:instructions:end -->\n')
        expect(await plan()).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_INPUT_INVALID', target: join(api, 'AGENTS.md') } })
    })

    it('uses canonical main authority in a nested worktree and lets an explicit override win', async () => {
        const first = await validInput()
        const nestedCwd = join(first.canonicalMainCheckout, '.worktrees', 'nested', 'deeper')
        const firstResult = planSiblingProjection({ ...first, invocationCwd: nestedCwd })
        expect(firstResult).toMatchObject({ kind: 'complete', guides: [{ sourceGuidePath: resolve(first.canonicalMainCheckout, '..', 'api', 'CLAUDE.md') }] })

        const overrideRoot = await mkdtemp(join(tmpdir(), 'cockpit-projection-override-'))
        roots.push(overrideRoot)
        await writeFile(join(overrideRoot, 'CLAUDE.md'), 'override guide\n')
        await writeFile(join(overrideRoot, 'AGENTS.md'), 'override guide\n')
        const overridden = await validInput({ override: overrideRoot })
        const overrideResult = planSiblingProjection(overridden)
        expect(overrideResult).toMatchObject({ kind: 'complete', guides: [{ sourceGuidePath: join(overrideRoot, 'CLAUDE.md') }] })
    })

    it('keeps a configured live guide symlink as the projection source', async () => {
        const input = await validInput()
        input.siblings[0]!.guides = ['AGENTS.md', 'CLAUDE.md']
        const result = planSiblingProjection(input)
        expect(result).toMatchObject({
            kind: 'complete',
            guides: [{
                guide: 'AGENTS.md',
                sourceGuidePath: resolve(input.canonicalMainCheckout, '..', 'api', 'AGENTS.md'),
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
            expect(result.guides).toEqual(expect.arrayContaining([
                expect.objectContaining({ sibling: 'mobile', guide: 'AGENTS.md' }),
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

    it('refuses a guide that is or resolves to a secret, whoever runs sync', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cockpit-projection-secret-'))
        roots.push(root)
        await mkdir(join(root, '.secrets'))
        await mkdir(join(root, 'config'))
        await mkdir(join(root, 'docs'))
        for (const path of ['.env', '.Env.local', '.secrets/notes.md', 'config/runtime.conf', 'docs/guide.md']) await writeFile(join(root, path), 'TOKEN=synthetic\n')
        await symlink('.env', join(root, 'AGENTS.md'))
        const observe = (guide: string) => observeSiblingGuides({ allowedRoots: [root], instances: [join(root, 'config/runtime.conf')],
            requests: [{ slug: 'api', root, sourcePath: join(root, guide) }] })

        for (const guide of ['.env', '.Env.local', '.env.missing', '.secrets/notes.md', 'config/runtime.conf', 'AGENTS.md']) {
            expect(await observe(guide), guide).toMatchObject({ kind: 'refusal', diagnostic: { code: 'PROJECTION_GUIDE_SECRET', target: join(root, guide) } })
        }
        expect(await observe('docs/guide.md')).toMatchObject({ kind: 'complete', observations: [{ content: 'TOKEN=synthetic\n' }] })
    })

    it('refuses aggregate guide observations beyond the snapshot bound', async () => {
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
        input.guideCapLines = 8
        const result = planSiblingProjection(input)
        // Each harness pays the seven lines of the copied guide; only Claude Code defers the scoped three.
        expect(result).toMatchObject({
            kind: 'complete',
            costs: [
                { target: 'claudecode', status: 'within_cap', metric: 'lines', value: 7, conditionalValue: 3, cap: 8 },
                { target: 'codexcli', status: 'exceeded', metric: 'lines', value: 10, conditionalValue: 0, cap: 8 },
                { target: 'opencode', status: 'exceeded', metric: 'lines', value: 10, conditionalValue: 0, cap: 8 },
            ],
            headline: { metric: 'lines', value: 10, target: 'codexcli' },
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

    it('refuses planner output amplification before capture is exhausted', async () => {
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
