import { describe, expect, it } from 'vitest'
import { inspectProseReferences, walkMarkdownProse } from '../../../scripts/docs-lint.mjs'

describe('named prose references', () => {
    it('checks schema and consumer references only against their explicit typed authorities', () => {
        const authority = { commands: new Set<string>(), diagnostics: new Set<string>(), identifiers: new Set<string>(), flags: new Set<string>(),
            schemaFields: new Set(['cockpit.guide_cap', 'surfaces.overlays[].replaces.sha256']),
            consumerPaths: new Set(['cockpit.toml', 'docs/cockpit/environment-decisions.md']) }
        const body = [
            '<!-- cockpit:ref schema=cockpit.guide_cap --> `cockpit.guide_cap`',
            '<!-- cockpit:ref schema=surfaces.overlays[].replaces.sha256 --> `surfaces.overlays[].replaces.sha256`',
            '<!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`',
            '<!-- cockpit:ref consumer=docs/cockpit/environment-decisions.md --> `docs/cockpit/environment-decisions.md`',
        ].join('\n')
        const inspect = (body: string) => inspectProseReferences({ path: 'docs/synthetic.md', body, authority, resolvePath: () => 'missing' })
        expect(inspect(body)).toEqual([])
        expect(inspect('`cockpit.toml`')).toMatchObject([{ code: 'DOCEV050_NAMED_REFERENCE_MISSING', message: 'cockpit.toml' }])
        for (const reference of ['schema=cockpit.guide_caps', 'schema=replaces.sha256', 'consumer=cockpit-typo.toml',
            'consumer=../cockpit.toml', 'consumer=/cockpit.toml', 'consumer=docs/other.md']) {
            expect(inspect(`<!-- cockpit:ref ${reference} -->`), reference).toMatchObject([{ code: 'DOCEV050_NAMED_REFERENCE_MISSING' }])
        }
        expect(inspect('Use `git push --all` or `git push --mirror`.')).toEqual([])
        expect(inspect('Use `--all`.')).toMatchObject([{ code: 'DOCEV050_NAMED_REFERENCE_MISSING' }])
        expect(inspect('Inspect `environment/generated-application.ts`.')).toMatchObject([{ code: 'DOCEV050_NAMED_REFERENCE_MISSING' }])
    })

    it('reads a group word and the word after it as one subcommand reference', () => {
        const authority = { commands: new Set(['sibling', 'work intake']), groups: new Set(['work']), diagnostics: new Set<string>(),
            identifiers: new Set<string>(), flags: new Set<string>() }
        const inspect = (body: string) => inspectProseReferences({ path: 'docs/synthetic.md', body, authority, resolvePath: () => 'missing' })
        expect(inspect('Run `cockpit work intake --config cockpit.toml`, `cockpit work --help` or `cockpit sibling add api`.\n'
            + '<!-- cockpit:ref command=work intake --> <!-- cockpit:ref command=work -->')).toEqual([])
        expect(inspect('Run `cockpit work-intake --config cockpit.toml`.')).toMatchObject([{ code: 'DOCEV050_NAMED_REFERENCE_MISSING', message: 'cockpit work-intake' }])
        expect(inspect('Run `cockpit work bogus`.')).toMatchObject([{ code: 'DOCEV050_NAMED_REFERENCE_MISSING', message: 'cockpit work bogus' }])
        expect(inspect('<!-- cockpit:ref command=work bogus -->')).toMatchObject([{ code: 'DOCEV050_NAMED_REFERENCE_MISSING', message: 'cockpit work bogus' }])
    })

    it('uses one visible prose walk for structural and structured reference checks', () => {
        const body = '```md\n~~~\n`MISSING_DIAGNOSTIC`\n```\n<!-- cockpit:ref path=docs/missing.md -->\nRun `cockpit missing-command`.\n'
        const walked = walkMarkdownProse('docs/synthetic.md', body)
        expect(walked.diagnostics).toEqual([])
        expect(walked.lines.map(row => row.line)).toEqual([5, 6, 7])
        expect(walked.lines[0]?.comments).toEqual(['cockpit:ref path=docs/missing.md'])
        const errors = inspectProseReferences({ path: 'docs/synthetic.md', body,
            authority: { commands: new Set(), diagnostics: new Set(), identifiers: new Set(), flags: new Set() }, resolvePath: () => 'missing' })
        expect(errors).toMatchObject([{ line: 5, message: expect.stringContaining('docs/missing.md') }, { line: 6, message: expect.stringContaining('cockpit missing-command') }])
        expect(walkMarkdownProse('docs/synthetic.md', '```md\n~~~\n').diagnostics).toMatchObject([{ code: 'DOC031_UNCLOSED_FENCE', line: 1 }])
    })

    it('retains multiline comment content at its opening line without hiding following prose', () => {
        const body = 'Before <!-- ordinary\n `MISSING_DIAGNOSTIC`\n --> after\n<!-- cockpit:ref\n path=docs/missing.md -->\n'
        const walked = walkMarkdownProse('docs/synthetic.md', body)
        expect(walked.diagnostics).toEqual([])
        expect(walked.lines[0]).toMatchObject({ line: 1, prose: 'Before ', comments: ['ordinary `MISSING_DIAGNOSTIC`'] })
        expect(walked.lines[2]).toMatchObject({ line: 3, prose: ' after', comments: [] })
        expect(walked.lines[3]).toMatchObject({ line: 4, comments: ['cockpit:ref path=docs/missing.md'] })
        expect(inspectProseReferences({ path: 'docs/synthetic.md', body,
            authority: { commands: new Set(), diagnostics: new Set(), identifiers: new Set(), flags: new Set() }, resolvePath: () => 'missing' }))
            .toMatchObject([{ line: 4, message: 'docs/missing.md' }])
    })
})
