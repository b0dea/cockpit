import { describe, expect, it } from 'vitest'

import { lintDocumentation, type Authority } from '../../../scripts/docs-lint.ts'
import { walkMarkdownProse } from './docs/markdown.js'

const authority: Authority = {
    files: new Set(['packages/cockpit/src/cli.ts']),
    identifiers: new Set(['SYNTHETIC_DEFINED']),
    commands: new Set(['sync', 'work', 'work intake']),
    schemaFields: new Set(['cockpit.guide_cap', 'surfaces.overlays[].replaces.sha256']),
}
const indexes = { 'docs/README.md': '# Docs\n\n[Concepts](concepts.md)\n', 'docs/contributing/README.md': '# Contributors\n' }
const concepts = '# Concepts\n\n## Sibling repository\n\nOne of the product repositories.\n'
const lint = (pages: Record<string, string>) => lintDocumentation(new Map(Object.entries({ ...indexes, 'docs/concepts.md': concepts, ...pages })), authority)
    .map(({ path, line, code, message }) => `${path}:${line} ${code} ${message}`)

describe('documentation checks', () => {
    it('resolves each structured reference against its own authority', () => {
        const page = (body: string) => lint({ 'docs/README.md': `${indexes['docs/README.md']}[Guide](guide.md)\n`, 'docs/guide.md': `# Guide\n\n${body}\n` })
        expect(page([
            '<!-- cockpit:ref path=packages/cockpit/src/cli.ts --> <!-- cockpit:ref schema=surfaces.overlays[].replaces.sha256 -->',
            '<!-- cockpit:ref command=work intake --> <!-- cockpit:ref command=work --> <!-- cockpit:ref consumer=cockpit.toml -->',
            '<!-- an ordinary comment -->',
        ].join('\n'))).toEqual([])
        expect(page([
            '<!-- cockpit:ref path=packages/cockpit/src/missing.ts -->',
            '<!-- cockpit:ref schema=cockpit.guide_caps --> <!-- cockpit:ref command=work bogus -->',
            '<!-- cockpit:ref consumer=../cockpit.toml -->',
            '<!-- cockpit:ref code=SYNTHETIC_DEFINED -->',
            '```md',
            '<!-- cockpit:ref path=inert/example.md -->',
            '```',
            '<!-- cockpit:ref',
            '  path=docs/missing.md -->',
        ].join('\n'))).toEqual([
            'docs/guide.md:3 DOCEV050_NAMED_REFERENCE_MISSING path=packages/cockpit/src/missing.ts',
            'docs/guide.md:4 DOCEV050_NAMED_REFERENCE_MISSING schema=cockpit.guide_caps',
            'docs/guide.md:4 DOCEV050_NAMED_REFERENCE_MISSING command=work bogus',
            'docs/guide.md:5 DOCEV050_NAMED_REFERENCE_MISSING consumer=../cockpit.toml',
            'docs/guide.md:6 DOCEV050_NAMED_REFERENCE_MISSING malformed structured reference: cockpit:ref code=SYNTHETIC_DEFINED',
            'docs/guide.md:10 DOCEV050_NAMED_REFERENCE_MISSING path=docs/missing.md',
        ])
    })

    it('flags a diagnostic code no tracked source defines, outside code blocks and comments', () => {
        expect(lint({ 'CONTRIBUTING.md': [
            '# Contributing', '', '`SYNTHETIC_DEFINED` is printed; `SYNTHETIC_UNDEFINED` never is.',
            '```sh', 'echo `FENCED_UNDEFINED`', '```', '<!-- `COMMENTED_UNDEFINED` -->', 'Prose CAPITAL_WORDS outside code are ignored.',
        ].join('\n') })).toEqual(['CONTRIBUTING.md:3 DOC071_CODE_UNDEFINED SYNTHETIC_UNDEFINED'])
    })

    it('requires the first mention of a glossary term on a page to link its definition', () => {
        const linked = '# Guide\n\nEach [sibling repository](../docs/concepts.md#sibling-repository) is cloned; a sibling repository is mounted.\n'
        expect(lint({ 'examples/guide.md': linked })).toEqual([])
        expect(lint({ 'examples/guide.md': '# Guide\n\nA sibling repository comes first, so a later [Sibling repository](../docs/concepts.md#sibling-repository) link is too late.\n' }))
            .toEqual(['examples/guide.md:3 DOC067_CONCEPT_UNLINKED Sibling repository'])
        // A term inside a link destination is part of a path, not a mention.
        expect(lint({ 'examples/guide.md': '# Guide\n\n[Setup](setup.md#sibling-repository)\n' })).toEqual([])
        expect(lintDocumentation(new Map([...Object.entries(indexes), ['docs/concepts.md', `${concepts}\n## Sibling Repository\n`]]), authority)
            .map(row => row.code)).toEqual(['DOC062_CONCEPT_DUPLICATE'])
    })

    it('requires each docs page in its estate index, and no index link across estates', () => {
        expect(lint({
            'docs/README.md': `${indexes['docs/README.md']}[Guide](guide.md#section)\n`,
            'docs/guide.md': '# Guide\n',
            'docs/contributing/README.md': '# Contributors\n\n[Decisions](decisions/README.md)\n',
            'docs/contributing/decisions/README.md': '# Decisions\n\n[One](one.md)\n',
            'docs/contributing/decisions/one.md': '# One\n',
        })).toEqual([])
        expect(lint({
            'docs/README.md': `${indexes['docs/README.md']}[Policy](contributing/style.md)\n`,
            'docs/orphan.md': '# Orphan\n',
            'docs/contributing/style.md': '# Style\n',
        })).toEqual([
            'docs/README.md:4 DOC061_ESTATE_CROSS_LINK contributing/style.md',
            'docs/orphan.md:1 DOC068_PAGE_UNINDEXED no consumer index page links to docs/orphan.md',
            'docs/contributing/style.md:1 DOC068_PAGE_UNINDEXED no contributor index page links to docs/contributing/style.md',
        ])
        expect(lintDocumentation(new Map([['docs/contributing/README.md', '# Contributors\n']]), authority).map(row => row.code))
            .toEqual(['DOC060_ESTATE_INDEX_MISSING'])
    })

    it('lifts comments out of the visible prose and refuses one that never closes', () => {
        const walked = walkMarkdownProse('---\ntitle: `HIDDEN_CODE`\n---\nBefore <!-- one\n `INSIDE` --> after\n~~~sh\n<!-- inert\n~~~')
        expect(walked.lines).toEqual([
            { line: 4, prose: 'Before ', comments: ['one `INSIDE`'] },
            { line: 5, prose: ' after', comments: [] },
        ])
        expect(walked.fences).toEqual([{ line: 6, info: 'sh' }])
        expect(lint({ 'CONTRIBUTING.md': '# Contributing\n\n<!-- never closed\n' }))
            .toEqual(['CONTRIBUTING.md:1 DOC031_UNCLOSED_COMMENT HTML comment opened on line 3 is not closed'])
    })
})
