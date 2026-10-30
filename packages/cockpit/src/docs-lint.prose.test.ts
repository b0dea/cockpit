import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import {
    cpSync,
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    classifyMarkdownPath,
    diagnosticInventory,
    deriveDocumentationInventory,
    lintMarkdown,
    repositoryMarkdownPaths,
    validateImpactLedger,
    validateAcceptanceEvidence,
    validateAcceptanceDocuments,
    validateEdgeCoverage,
    validateEdgeCoverageDocuments,
    validateNavigationEvidence,
    validateNavigationEvidenceFromManifest,
    validateOperatorReviewEvidence,
    validateReviewEvidence,
    validateReviewReports,
    validateRuntimeEvidence,
    writeReviewManifest,
    walkMarkdownProse,
    inspectProseReferences,
} from '../../../scripts/docs-lint.mjs'
import {
    checkRepositoryReferences,
    diagnosticInventory as maintainerDiagnosticInventory,
    exported,
    productionTypeScriptPaths,
    publishRepositoryReferences,
    typeScriptSource,
} from '../../../scripts/diagnostic-inventory.mjs'
import { ROOT, LINTER, committedReferenceFixture, malformedGitBoundary, writeEvidence, commentIdForTest, signNavigation, createEvidenceFixture, createCommittedEvidenceFixture, writeJson } from '../test-support/docs-fixtures.js'
import type { EvidenceRow, EvidenceDocument } from '../test-support/docs-fixtures.js'



describe('documentation estate classification', () => {
    it('classifies every repository Markdown path before linting', () => {
        const paths = repositoryMarkdownPaths()

        expect(paths.length, 'a documentation scan over no paths passes vacuously').toBeGreaterThan(8)
        expect(paths.filter((path) => classifyMarkdownPath(path) === null)).toEqual([])
    })

    it.each([
        ['README.md', 'human'],
        ['packages/cockpit/README.md', 'human'],
        ['packages/cockpit/CHANGELOG.md', 'human'],
        ['docs/contributing/style.md', 'human'],
        ['docs/contributing/decisions/operator-paths.md', 'human'],
        ['docs/contributing/decisions/installed-capabilities.md', 'human'],
        ['examples/synthetic/README.md', 'human'],
        ['packages/cockpit/libexec/rulesync-generator.NOTICE.md', 'human'],
        ['packages/cockpit/surfaces/README.md', 'executable'],
        ['packages/cockpit/surfaces/agents/evaluator.agent.md', 'executable'],
        ['fixtures/docs/human-valid.md', 'fixture'],
    ] as const)('classifies %s as %s', (path, estate) => {
        expect(classifyMarkdownPath(path)).toBe(estate)
    })

    it('fails closed with the path of an unclassified Markdown document', () => {
        expect(classifyMarkdownPath('notes/unknown.md')).toBeNull()
        expect(lintMarkdown('notes/unknown.md', '# Unknown\n')).toEqual([
            {
                code: 'DOC001_UNCLASSIFIED',
                line: 1,
                message: 'Markdown path belongs to no declared documentation estate',
                path: 'notes/unknown.md',
            },
        ])
    })

    it('enumerates every NUL-delimited path from Git, including an unclassified control', () => {
        const root = mkdtempSync(join(tmpdir(), 'docs-lint-corpus-'))
        try {
            mkdirSync(join(root, 'notes'))
            writeFileSync(join(root, 'README.md'), 'Repository purpose.\n')
            writeFileSync(join(root, 'notes', 'unknown\npage.md'), 'Unclassified.\n')
            execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
            execFileSync('git', ['add', 'README.md', 'notes/unknown\npage.md'], { cwd: root, stdio: 'ignore' })

            const paths = repositoryMarkdownPaths(root)
            expect(paths).toEqual(['README.md', 'notes/unknown\npage.md'])
            expect(paths.filter((path) => classifyMarkdownPath(path) === null)).toEqual(['notes/unknown\npage.md'])
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('accepts explicit valid fixture subjects through the executable boundary', () => {
        const result = spawnSync(
            process.execPath,
            [LINTER, 'fixtures/docs/human-valid.md', 'fixtures/docs/executable-valid.md'],
            { cwd: ROOT, encoding: 'utf8' },
        )

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe('')
    })

    it('keeps executable instructions out of human-only purpose checks', () => {
        const body = readFileSync(new URL('../../../fixtures/docs/executable-valid.md', import.meta.url), 'utf8')
        expect(lintMarkdown('fixtures/docs/executable-valid.md', body)).toEqual([])
    })
})

describe('Markdown structure controls', () => {
    it.each(['script-x', 'style-guide', 'template-slot'])(
        'does not let the custom element <%s> suppress subsequent Markdown diagnostics',
        (element) => {
            const body = `# Control\n<${element}>\n### Skip\n[]()\n</${element}>\n`

            expect(lintMarkdown('fixtures/docs/executable-valid.md', body)).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ code: 'DOC020_HEADING_ORDER', line: 3 }),
                    expect.objectContaining({ code: 'DOC040_MALFORMED_LINK', line: 4 }),
                ]),
            )
        },
    )

    it.each([' ', '  ', '   '])('checks heading order after %s leading spaces', (indent) => {
        const body = `# Control\n${indent}### Skip\n`

        expect(lintMarkdown('fixtures/docs/executable-valid.md', body)).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: 'DOC020_HEADING_ORDER', line: 2 })]),
        )
    })

    it('keeps a four-space indented hash line as code rather than a heading', () => {
        const diagnostics = lintMarkdown('fixtures/docs/executable-valid.md', '# Control\n    ### Code\n')

        expect(diagnostics.map(({ code }) => code)).not.toContain('DOC020_HEADING_ORDER')
    })
})

describe('mechanical documentation style', () => {
    const readFixture = (name: string) =>
        readFileSync(new URL(`../../../fixtures/docs/${name}`, import.meta.url), 'utf8')
    const expectHeadingAndLinkDiagnostics = (lines: string[], headingLine: number) => {
        expect(lintMarkdown('fixtures/docs/executable-valid.md', lines.join('\n'))).toEqual([
            expect.objectContaining({ code: 'DOC020_HEADING_ORDER', line: headingLine }),
            expect.objectContaining({ code: 'DOC040_MALFORMED_LINK', line: headingLine + 1 }),
        ])
    }

    it('accepts a human document that exercises every structural rule', () => {
        expect(lintMarkdown('fixtures/docs/human-valid.md', readFixture('human-valid.md'))).toEqual([])
    })

    it('requires an opening prose signal in human documentation', () => {
        expect(lintMarkdown('fixtures/docs/human-invalid-purpose.md', readFixture('human-invalid-purpose.md'))).toEqual([
            expect.objectContaining({ code: 'DOC010_PURPOSE_AUDIENCE', path: 'fixtures/docs/human-invalid-purpose.md' }),
        ])
    })

    it('does not count frontmatter or HTML comments as opening prose', () => {
        expect(
            lintMarkdown('fixtures/docs/human-invalid-frontmatter.md', readFixture('human-invalid-frontmatter.md')),
        ).toEqual([
            expect.objectContaining({ code: 'DOC010_PURPOSE_AUDIENCE', path: 'fixtures/docs/human-invalid-frontmatter.md' }),
        ])
    })

    it('does not count an HTML-only block as opening prose', () => {
        expect(lintMarkdown('fixtures/docs/human-invalid-html.md', readFixture('human-invalid-html.md'))).toEqual([
            expect.objectContaining({ code: 'DOC010_PURPOSE_AUDIENCE', path: 'fixtures/docs/human-invalid-html.md' }),
        ])
    })

    it.each(['script', 'style', 'template'])('does not count an HTML %s body as opening prose', (element) => {
        const path = `fixtures/docs/human-invalid-${element}.md`
        expect(lintMarkdown(path, readFixture(`human-invalid-${element}.md`))).toEqual([
            expect.objectContaining({ code: 'DOC010_PURPOSE_AUDIENCE', path }),
        ])
    })

    it('suppresses every Markdown rule inside raw elements and keeps nested template content inert', () => {
        expect(
            lintMarkdown(
                'fixtures/docs/human-invalid-raw-elements.md',
                readFixture('human-invalid-raw-elements.md'),
            ),
        ).toEqual([
            expect.objectContaining({
                code: 'DOC010_PURPOSE_AUDIENCE',
                path: 'fixtures/docs/human-invalid-raw-elements.md',
            }),
        ])
    })

    it('does not tokenize raw elements inside fenced examples', () => {
        const body = [
            '# Synthetic guide',
            '',
            'This guide explains a synthetic HTML example.',
            '',
            '```html',
            '<script>',
            '[Hidden script link](',
            '> [!UNKNOWN]',
            '```',
            '',
        ].join('\n')

        expect(lintMarkdown('fixtures/docs/human-valid.md', body)).toEqual([])
    })

    it.each(['script', 'style', 'template'])('keeps diagnostics after an inline literal <%s>', (element) => {
        const body = [
            '# Synthetic guide',
            '',
            `This guide documents the literal \`<${element}>\` spelling.`,
            '',
            '### Skipped heading',
            '[Broken link]( )',
            '> [!DANGER]',
            '',
        ].join('\n')

        expect(lintMarkdown('fixtures/docs/human-valid.md', body).map(({ code }) => code)).toEqual([
            'DOC020_HEADING_ORDER',
            'DOC040_MALFORMED_LINK',
            'DOC050_UNKNOWN_ADMONITION',
        ])
    })

    it.each(['script', 'style', 'template'])('keeps diagnostics after an escaped raw-element literal \\<%s>', (element) => {
        const path = `fixtures/docs/human-invalid-escaped-${element}.md`

        expect(lintMarkdown(path, readFixture(`human-invalid-escaped-${element}.md`)).map(({ code }) => code)).toEqual([
            'DOC020_HEADING_ORDER',
            'DOC040_MALFORMED_LINK',
            'DOC050_UNKNOWN_ADMONITION',
        ])
    })

    it('does not let a raw-element spelling inside an HTML comment suppress later diagnostics', () => {
        const body = '# Synthetic guide\n<!-- <script> -->\n### Skipped heading\n[Broken link]( )\n'

        expect(lintMarkdown('fixtures/docs/executable-valid.md', body).map(({ code }) => code)).toEqual([
            'DOC020_HEADING_ORDER',
            'DOC040_MALFORMED_LINK',
        ])
    })

    it.each(['script', 'style', 'template'])(
        'ends a raw <%s> block when its closing tag is wrapped in an HTML comment',
        (element) => {
            const body = readFixture(`human-invalid-comment-closed-${element}.md`)
            expect(lintMarkdown('fixtures/docs/executable-valid.md', body).map(({ code }) => code)).toEqual([
                'DOC020_HEADING_ORDER',
                'DOC040_MALFORMED_LINK',
            ])
        },
    )

    it.each(['script', 'style', 'template'])(
        'does not let a literal HTML comment opener inside raw <%s> text suppress later diagnostics',
        (element) => {
            const body = [
                '# Synthetic guide',
                `<${element}>`,
                "const marker = '<!--'",
                `</${element}>`,
                '### Skipped heading',
                '[Broken link]( )',
                '',
            ].join('\n')

            expect(lintMarkdown('fixtures/docs/executable-valid.md', body).map(({ code }) => code)).toEqual([
                'DOC020_HEADING_ORDER',
                'DOC040_MALFORMED_LINK',
            ])
        },
    )

    it.each(['script', 'style', 'template'])(
        'keeps raw <%s> state across a close and reopen on the same line',
        (element) => {
            const body = [
                '# Synthetic guide',
                `<${element}>`,
                `</${element}><${element}><!--`,
                `</${element}>`,
                '### Skipped heading',
                '[]( )',
                '',
            ].join('\n')

            expect(lintMarkdown('fixtures/docs/executable-valid.md', body).map(({ code }) => code)).toEqual([
                'DOC020_HEADING_ORDER',
                'DOC040_MALFORMED_LINK',
            ])
        },
    )

    it.each([
        ['same-line', ['<!-- <template> -->']],
        ['multiline', ['<!--', '<template>', '-->']],
    ])('ignores a template opener inside a %s raw-template comment', (_kind, commentLines) => {
        const body = [
            '# Synthetic guide',
            '<template>',
            ...commentLines,
            '</template>',
            '### Skipped heading',
            '[]( )',
            '',
        ].join('\n')

        const diagnostics = lintMarkdown('fixtures/docs/executable-valid.md', body)
        expect(diagnostics.map(({ code }) => code)).toEqual([
            'DOC020_HEADING_ORDER',
            'DOC040_MALFORMED_LINK',
        ])
    })

    it('ignores a multiline comment-contained template close until the real close', () => {
        expectHeadingAndLinkDiagnostics([
            '# Synthetic guide',
            '<template>',
            '<!--',
            '</template>',
            '-->',
            '### Hidden heading',
            '[]( )',
            '</template>',
            '### Skipped heading',
            '[]( )',
            '',
        ], 9)
    })

    it('does not let an unrelated later comment close activate a literal raw-template opener', () => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template>',
            "const marker = '<!--'",
            '</template>',
            '### Skipped',
            '[]( )',
            '-->',
            '',
        ], 5)
    })

    it('does not treat an embedded same-line raw-template marker as a comment', () => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template>',
            "const marker = '<!--'; </template> -->",
            '### Skipped',
            '[]( )',
            '',
        ], 4)
    })

    it('recognises a matched template comment immediately after the raw opener', () => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template><!--',
            '<template>',
            '-->',
            '</template>',
            '### Skipped',
            '[]( )',
            '',
        ], 6)
    })

    it('keeps a matched immediate template comment close inert until the real close', () => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '',
            '<template><!--',
            '</template>',
            '-->',
            '### Hidden',
            '[]( )',
            '</template>',
            '### Skipped',
            '[]( )',
            '',
        ], 9)
    })

    it.each([
        ['after markup', ['<div><!-- <template> --></div>']],
        ['after text', ['Text before <!-- <template> -->']],
        ['multiline after markup', ['<div><!--', '<template>', '-->', '</div>']],
    ])('recognises a matched raw-template comment %s', (_kind, commentLines) => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template>',
            ...commentLines,
            '</template>',
            '### Skipped',
            '[]( )',
            '',
        ], commentLines.length + 4)
    })

    it('recognises a multiline comment after markup on the raw-template opener line', () => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template><div><!--',
            '<template>',
            '-->',
            '</div>',
            '</template>',
            '### Skipped',
            '[]( )',
            '',
        ], 7)
    })

    it.each([
        ['single quote', "const marker = '<!--'; </template> -->"],
        ['double quote', 'const marker = "<!--"; </template> -->'],
        ['backtick', 'const marker = `<!--`; </template> -->'],
        ['escaped quote', String.raw`const marker = 'it\'s <!--'; </template> -->`],
    ])('keeps a raw-template marker inside a %s literal inert', (_kind, markerLine) => {
        expectHeadingAndLinkDiagnostics(['# Control', '<template>', markerLine, '### Skipped', '[]( )', ''], 4)
    })

    it.each([
        ['an apostrophe', "It's ready </template>"],
        ['an unmatched double quote', 'const marker = "unterminated; </template>'],
        ['backtick punctuation', 'Ordinary text: ` punctuation </template>'],
        ['return prose before a backtick', 'We return ` </template>'],
        ['an equals sign before a backtick', 'Ordinary = ` </template>'],
    ])('does not let %s hide a raw-template close', (_kind, closingLine) => {
        expectHeadingAndLinkDiagnostics(['# Control', '<template>', closingLine, '### Skipped', '[]( )', ''], 4)
    })

    it('keeps raw tokens inside a bounded multiline backtick literal inert', () => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template>',
            'const marker = `',
            '<!-- <template> -->',
            '`',
            '</template>',
            '### Skipped',
            '[]( )',
            '',
        ], 7)
    })

    it('keeps an escaped backtick open until the bounded multiline literal closes', () => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template>',
            'const marker = `escaped ' + '\\' + '`',
            '<template>',
            '`',
            '</template>',
            '### Skipped',
            '[]( )',
            '',
        ], 7)
    })

    it('does not carry an unmatched backtick across the raw-template close', () => {
        expectHeadingAndLinkDiagnostics(
            ['# Control', '<template>', 'const marker = `', '</template>', '### Skipped', '[]( )', ''],
            5,
        )
    })

    it.each([
        ['object property', 'const value = { field: `', '` }'],
        ['parenthesized return', 'return (`', '`)'],
        ['concatenation', 'const value = prefix + `', '`'],
    ])('recognises a bounded %s multiline backtick literal', (_kind, openingLine, closingLine) => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template>',
            openingLine,
            '<template>',
            closingLine,
            '</template>',
            '### Skipped',
            '[]( )',
            '',
        ], 7)
    })

    it.each([
        ['plain', '</template>'],
        ['after an unmatched apostrophe', "It's ready </template>"],
    ])('honours a raw-template close %s before a future backtick', (_kind, closingLine) => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template>',
            'const marker = `',
            closingLine,
            '### Skipped',
            '[]( )',
            '`',
            '',
        ], 5)
    })

    it('counts actual nested templates after a multiline backtick literal closes', () => {
        expectHeadingAndLinkDiagnostics([
            '# Control',
            '<template>',
            'const marker = `',
            '<template>',
            '`',
            '<template>',
            '</template>',
            '</template>',
            '### Skipped',
            '[]( )',
            '',
        ], 9)
    })

    it('masks inline code in Markdown after a same-line raw-element close', () => {
        const body = [
            '# Synthetic guide',
            '<script>',
            '</script> `<!--`',
            '### Skipped heading',
            '[Broken link]( )',
            '',
        ].join('\n')

        expect(lintMarkdown('fixtures/docs/executable-valid.md', body).map(({ code }) => code)).toEqual([
            'DOC020_HEADING_ORDER',
            'DOC040_MALFORMED_LINK',
        ])
    })

    it.each([
        ['plain', '</script> ### Skipped heading [Broken link]( )'],
        ['comment-wrapped', '<!-- </script> --> ### Skipped heading [Broken link]( )'],
    ])('preserves Markdown after a %s raw-element close on the same line', (_kind, closingLine) => {
        const body = `# Synthetic guide\n<script>\n${closingLine}\n`

        expect(lintMarkdown('fixtures/docs/executable-valid.md', body).map(({ code }) => code)).toEqual([
            'DOC020_HEADING_ORDER',
            'DOC040_MALFORMED_LINK',
        ])
    })

    it('preserves visible Markdown before and after a same-line HTML comment', () => {
        const body = '# Synthetic guide\n### Skipped <!-- hidden --> [Broken link]( )\n'

        expect(lintMarkdown('fixtures/docs/executable-valid.md', body).map(({ code }) => code)).toEqual([
            'DOC020_HEADING_ORDER',
            'DOC040_MALFORMED_LINK',
        ])
    })

    it('preserves visible Markdown around a multiline HTML comment', () => {
        const body = '# Synthetic guide\n### Skipped heading <!-- hidden\n<script>\n--> [Broken link]( )\n'

        expect(lintMarkdown('fixtures/docs/executable-valid.md', body).map(({ code }) => code)).toEqual([
            'DOC020_HEADING_ORDER',
            'DOC040_MALFORMED_LINK',
        ])
    })

    it('treats only an odd run of backslashes as escaping a raw-element opener', () => {
        const body = [
            '# Synthetic guide',
            '',
            'This guide documents Markdown escaping.',
            '',
            String.raw`\\<script>`,
            '### Hidden skipped heading',
            '[Hidden broken link](',
            '> [!DANGER]',
            '',
        ].join('\n')

        expect(lintMarkdown('fixtures/docs/human-valid.md', body)).toEqual([])
    })

    it.each([
        ['human', 'fixtures/docs/human-invalid-unclosed-frontmatter.md'],
        ['executable', 'fixtures/docs/executable-invalid-unclosed-frontmatter.md'],
    ])('fails closed on unclosed frontmatter in %s documentation', (_estate, path) => {
        expect(lintMarkdown(path, readFixture(path.split('/').at(-1) ?? '')).map(({ code }) => code)).toEqual([
            'DOC011_UNCLOSED_FRONTMATTER',
            'DOC020_HEADING_ORDER',
            'DOC040_MALFORMED_LINK',
            'DOC050_UNKNOWN_ADMONITION',
        ])
    })

    it('retains visible prose inside ordinary inline HTML', () => {
        const body = '# Synthetic guide\n\n<p>This guide helps an operator understand the synthetic workflow.</p>\n'
        expect(lintMarkdown('fixtures/docs/human-valid.md', body)).toEqual([])
    })

    it('reports every deliberately broken structural control by its named code', () => {
        const codes = lintMarkdown(
            'fixtures/docs/human-invalid-structure.md',
            readFixture('human-invalid-structure.md'),
        ).map((diagnostic) => diagnostic.code)

        expect(codes).toEqual([
            'DOC020_HEADING_ORDER',
            'DOC030_FENCE_LANGUAGE',
            'DOC040_MALFORMED_LINK',
            'DOC050_UNKNOWN_ADMONITION',
            'DOC031_UNCLOSED_FENCE',
        ])
    })

    it('does not apply the human opening rule to executable instructions', () => {
        const executable = '# Synthetic command\n\n```sh\nprintf "checked\\n"\n```\n'
        expect(lintMarkdown('packages/cockpit/surfaces/skills/synthetic.skill.md', executable)).toEqual([])
    })

    it('rejects an explicit subject that is not Markdown or a declared fixture', () => {
        const result = spawnSync(process.execPath, [LINTER, 'fixtures/docs/unclassified.md.txt'], {
            cwd: ROOT,
            encoding: 'utf8',
        })

        expect(result.status).toBe(1)
        expect(result.stderr).toContain(
            'fixtures/docs/unclassified.md.txt:1 [DOC001_UNCLASSIFIED] Markdown path belongs to no declared documentation estate',
        )
    })

    it('keeps the written policy under the rules it defines', () => {
        const body = readFileSync(new URL('../../../docs/contributing/style.md', import.meta.url), 'utf8')
        expect(lintMarkdown('docs/contributing/style.md', body)).toEqual([])
    })
})
