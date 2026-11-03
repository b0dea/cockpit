import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../test-support/docs-fixtures.js'

describe('maintained prose detectors', () => {
    async function detectors() {
        return await import('../../../scripts/docs-lint.mjs') as unknown as {
            inspectInternalLinks(input: { path: string; body: string; readTarget(path: string): string }): Array<{ code: string }>
            validateDocumentationIndexes(input: { readDocument(path: string): string; documents?: string[] }): Array<{ code: string }>
            buildExternalLinkReport(input: {
                documents: Array<{ path: string; body: string }>
                checkedAt: string
                check(url: string): Promise<{ status: 'ok' | 'broken' | 'unavailable'; httpStatus?: number }>
            }): Promise<{ checkedAt: string; summary: { checked: number; ok: number; broken: number; unavailable: number }; links: Array<{ url: string; sources: unknown[]; status: string }> }>
            requestExternalLink(url: string): Promise<{ status: string; httpStatus?: number }>
            inspectMaintainedProse(input: { documents: Array<{ path: string; body: string }>; currentVersion: string; staleMinorThreshold?: number; mechanismExists?(path: string): boolean; identifierExists?(identifier: string): boolean; today?: string }): {
                diagnostics: Array<{ code: string }>; reports: Array<{ code: string }>
            }
        }
    }

    it('rejects missing, retired, and stale-anchor internal links through the prose walker', async () => {
        const { inspectInternalLinks } = await detectors()
        const documents: Record<string, string> = {
            'docs/current.md': '# Current heading\n',
            'docs/current(with-parentheses).md': '# Parenthesized target\n',
            'docs/retired.md': '# Retired\n\n<!-- cockpit:retired -->\n',
        }
        const inspect = (body: string) => inspectInternalLinks({
            path: 'docs/source.md',
            body,
            readTarget: path => {
                if (!(path in documents)) throw new Error('missing fixture')
                return documents[path]
            },
        })
        expect(inspect('[missing](missing.md)')).toMatchObject([{ code: 'DOCEV026_LINK_MISSING' }])
        expect(inspect('[old](retired.md)')).toMatchObject([{ code: 'REFERENCE_RETIRED' }])
        expect(inspect('[stale](current.md#missing)')).toMatchObject([{ code: 'DOCEV027_LINK_ANCHOR_MISSING' }])
        expect(inspect('[current](current.md#current-heading)')).toEqual([])
        expect(inspect('[current][target]\n\n[target]: current.md#current-heading')).toEqual([])
        expect(inspect('[broken][missing]')).toMatchObject([{ code: 'DOC041_REFERENCE_UNRESOLVED' }])
        expect(inspect('![broken][missing]')).toMatchObject([{ code: 'DOC041_REFERENCE_UNRESOLVED' }])
        expect(inspect('[current](current(with-parentheses).md#parenthesized-target)')).toEqual([])
        expect(inspect('```md\n[control](missing.md)\n```')).toEqual([])
    })

    it('keeps consumer and contributor navigation in separate indexes', async () => {
        const { validateDocumentationIndexes } = await detectors()
        const documents: Record<string, string> = {
            'docs/README.md': '# Guides\n\n[guide](environment.md)\n',
            'docs/contributing/README.md': '# Contributors\n\n[policy](style.md)\n',
        }
        const validate = () => validateDocumentationIndexes({ readDocument: path => documents[path] })
        expect(validate()).toEqual([])
        documents['docs/README.md'] += '[internal policy](contributing/style.md)\n'
        expect(validate()).toMatchObject([{ code: 'DOC061_ESTATE_CROSS_LINK' }])
        documents['docs/README.md'] = '# Guides\n\n[guide](environment.md)\n'
        documents['docs/contributing/README.md'] += '[operator guide](../environment.md)\n'
        expect(validate()).toMatchObject([{ code: 'DOC061_ESTATE_CROSS_LINK' }])
        documents['docs/contributing/README.md'] = '# Contributors\n\n[policy](style.md)\n'
        documents['docs/guide.md'] = '# Guide\n\n[maintainer policy](contributing/style.md)\n'
        expect(validateDocumentationIndexes({ readDocument: path => documents[path], documents: Object.keys(documents) }))
            .toMatchObject([{ code: 'DOC061_ESTATE_CROSS_LINK' }])
    })

    it('reports broken external links without turning the report into a gate', async () => {
        const { buildExternalLinkReport, requestExternalLink } = await detectors()
        const checked: string[] = []
        const report = await buildExternalLinkReport({
            checkedAt: '2026-10-25T00:00:00.000Z',
            documents: [{ path: 'docs/README.md', body: [
                '# Links',
                '',
                '[healthy][health]',
                '[broken](https://example.invalid/broken)',
                '[balanced](HTTPS://example.invalid/a_(b))',
                '```md',
                '[inert control](https://example.invalid/inert)',
                '```',
                '',
                '[health]: https://example.invalid/healthy',
            ].join('\n') }],
            check: async url => {
                checked.push(url)
                return url.endsWith('/broken') ? { status: 'broken', httpStatus: 404 } : { status: 'ok', httpStatus: 200 }
            },
        })
        expect(checked.sort()).toEqual(['HTTPS://example.invalid/a_(b)', 'https://example.invalid/broken', 'https://example.invalid/healthy'])
        expect(report).toMatchObject({
            checkedAt: '2026-10-25T00:00:00.000Z',
            summary: { checked: 3, ok: 2, broken: 1, unavailable: 0 },
            links: [
                { url: 'HTTPS://example.invalid/a_(b)', status: 'ok', sources: [{ path: 'docs/README.md', line: 5 }] },
                { url: 'https://example.invalid/broken', status: 'broken', sources: [{ path: 'docs/README.md', line: 4 }] },
                { url: 'https://example.invalid/healthy', status: 'ok', sources: [{ path: 'docs/README.md', line: 3 }] },
            ],
        })
        const originalFetch = globalThis.fetch
        const methods: string[] = []
        globalThis.fetch = (async (_url: string | URL | Request, options?: RequestInit) => {
            methods.push(options?.method ?? '')
            return { status: options?.method === 'HEAD' ? 403 : 429 } as Response
        }) as typeof fetch
        try {
            await expect(requestExternalLink('https://example.invalid/rate-limited'))
                .resolves.toMatchObject({ status: 'unavailable', httpStatus: 429 })
            expect(methods).toEqual(['HEAD', 'GET'])
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    // docs-lint reads the version from packages/cockpit/package.json. A page verified at an earlier
    // release stays valid until it falls outside the stale window, so a release bump alone must not
    // turn this red.
    it('checks repository prose against the shipped workspace version', () => {
        const result = spawnSync(process.execPath, [join(ROOT, 'scripts/docs-lint.mjs')], {
            cwd: ROOT, encoding: 'utf8', timeout: 60_000,
        })
        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.stderr).not.toContain('[DOC063_VERIFIED_VERSION_INVALID]')
        expect(result.stdout).not.toContain('[DOC069_VERIFIED_VERSION_MISSING]')
    }, 65_000)

    it('checks vocabulary, capture metadata, enforcement mechanisms, and reports stale verification', async () => {
        const { inspectMaintainedProse } = await detectors()
        const valid = inspectMaintainedProse({
            currentVersion: '2.4.0',
            today: '2026-10-25',
            mechanismExists: path => path === 'scripts/docs-lint.mjs',
            identifierExists: identifier => identifier === 'SYNTHETIC_DEFINED',
            documents: [
                { path: 'docs/concepts.md', body: '# Concepts\n\n<!-- cockpit:verified version=2.4.0 -->\n\n## Registry\n\nA registry declares resources.\n' },
                { path: 'docs/guide.md', body: [
                    '# Guide',
                    '<!-- cockpit:verified version=2.2.0 -->',
                    '',
                    'Use the [Registry][registry]; `SYNTHETIC_DEFINED` names a code the source defines.',
                    // Only the first mention links; repeating the link on every mention is noise.
                    'The Registry is read again later, and this Registry mention needs no link.',
                    '```text',
                    'SYNTHETIC_FENCED is sample output, not a reference: `SYNTHETIC_FENCED`',
                    '```',
                    '<!-- cockpit:capture date=2026-10-25 version=2.4.0 --> ![terminal](terminal.png)',
                    '<!-- cockpit:ref path=scripts/docs-lint.mjs --> The linter enforces this rule.',
                    'Checked in CI.',
                    '',
                    '[registry]: concepts.md#registry',
                ].join('\n') },
                // A release fragment is copied verbatim into the generated changelog, so it carries
                // no verification marker; the changeset guide beside it still does.
                { path: '.changeset/initial-release.md', body: '---\n"@b00dea/cockpit": minor\n---\n\nInitial release.\n' },
                // A generated page is verified by regeneration, so a release bump must not make it
                // need a hand-maintained version.
                { path: 'docs/command-list.md', body: '# Command list\n\n<!-- Generated by `npm run references`; edit its sources, not this file. -->\n\nThe command table supplies this list.\n' },
            ],
        })
        expect(valid.diagnostics).toEqual([])
        expect(valid.reports).toMatchObject([{ code: 'DOC064_VERIFIED_VERSION_STALE' }])

        const broken = inspectMaintainedProse({
            currentVersion: '2.4.0',
            today: '2026-10-25',
            mechanismExists: () => true,
            identifierExists: identifier => identifier === 'SYNTHETIC_DEFINED',
            documents: [
                { path: 'docs/concepts.md', body: '# Concepts\n\n## Registry\n\n## Registry\n' },
                // A documented code that nothing outside documentation and tests defines tells the
                // reader to look for a diagnostic cockpit can never print.
                { path: 'docs/codes.md', body: '# Codes\n<!-- cockpit:verified version=2.4.0 -->\n\n`SYNTHETIC_UNDEFINED` means a retired budget was exceeded; `SYNTHETIC_DEFINED` is current.\n' },
                { path: '.changeset/README.md', body: '# Changesets\n\nHow to write a release fragment.\n' },
                { path: 'docs/guide.md', body: '# Guide\n<!-- cockpit:verified version=2.5.0 -->\n\nThe Registry comes first, so a later [Registry](concepts.md#registry) link is too late.\n\n![screenshot: terminal](terminal.png)\n\n~~~console\noutput\n~~~\n\n<!-- cockpit:capture date=2026-02-30 version=2.4.0 --> Evidence.\n\n<!-- cockpit:ref path=../outside --> The check enforces it.\n' },
            ],
        })
        expect(broken.diagnostics.map(row => row.code)).toEqual(expect.arrayContaining([
            'DOC062_CONCEPT_DUPLICATE',
            'DOC065_CAPTURE_METADATA_MISSING',
            'DOC066_ENFORCEMENT_MECHANISM_MISSING',
            'DOC067_CONCEPT_UNLINKED',
            'DOC063_VERIFIED_VERSION_INVALID',
        ]))
        expect(broken.diagnostics.filter(row => row.code === 'DOC071_CODE_UNDEFINED')).toMatchObject([{ path: 'docs/codes.md', line: 4, message: 'SYNTHETIC_UNDEFINED' }])
        expect(broken.diagnostics.filter(row => row.code === 'DOC067_CONCEPT_UNLINKED')).toMatchObject([{ path: 'docs/guide.md', line: 4, message: 'Registry' }])
        expect(broken.diagnostics.filter(row => row.code === 'DOC065_CAPTURE_METADATA_MISSING')).toHaveLength(3)
        expect(broken.reports).toMatchObject([
            { code: 'DOC069_VERIFIED_VERSION_MISSING', path: 'docs/concepts.md' },
            { code: 'DOC069_VERIFIED_VERSION_MISSING', path: '.changeset/README.md' },
        ])
    })

    it('runs external checking only on a scheduled or manual read-only workflow with pinned actions', () => {
        const workflow = readFileSync(join(ROOT, '.github/workflows/external-links.yml'), 'utf8')
        expect(workflow).toContain('schedule:')
        expect(workflow).toContain('workflow_dispatch:')
        expect(workflow).not.toContain('pull_request:')
        expect(workflow).toContain('permissions:\n  contents: read')
        expect(workflow).toContain('node scripts/docs-lint.mjs --external-report')
        // Any pinned release: Dependabot moves the SHA, and the loop below checks it is a full commit.
        expect(workflow).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} /)
        for (const reference of workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
            expect(reference[1]).toMatch(/^[0-9a-f]{40}$/)
        }
    })
})
