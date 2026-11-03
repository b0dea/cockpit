import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { walkMarkdownProse } from '../../../scripts/docs-lint.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PUBLIC_POLICIES = [
    'README.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'CHANGELOG.md',
] as const

// Surfaces run inside a consumer's cockpit after cockpit is installed there, so they read the guide
// from the installation; the repository may be private, and the agent may be offline.
const INSTALLED_GUIDE = /\.\/node_modules\/@b00dea\/cockpit\/(docs\/[^\s`'",)]+)/g
const PUBLIC_GUIDE = /https:\/\/(?:github\.com\/b0dea\/cockpit\/blob\/main|raw\.githubusercontent\.com\/b0dea\/cockpit\/main)\/docs\/[^\s>)'"]*/g
const ADOPTION_SKILL = 'scripts/adopt-cockpit.skill.md'

function trackedFiles(): string[] {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
}

function shippedGuidePages(): Set<string> {
    return new Set(trackedFiles().filter((path) => path.startsWith('docs/') && !path.startsWith('docs/contributing/') && path.endsWith('.md')))
}

function headings(page: string): string[] {
    return walkMarkdownProse(readFileSync(new URL(`../../../${page}`, import.meta.url), 'utf8')).lines
        .flatMap((row) => /^#{1,6}\s+(.+?)\s*$/.exec(row.prose)?.[1] ?? [])
}

// Wording that is true only while the package is unpublished. Whoever makes the package public
// must find every instance, so the release checklist names each file that holds one.
const PRE_PUBLICATION = new RegExp(['not yet published', 'not yet on npm', 'not on npm yet', 'nothing is published yet',
    'nothing has been released yet', 'until the first release', 'until its first release', 'after the first npm release',
    'package publication is pending', 'before publication'].map(phrase => phrase.replaceAll(' ', '\\s+')).join('|'), 'i')

function trackedDocumentation(): string[] {
    return execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' })
        .split('\0')
        .filter((path) => path !== '')
}

describe('effective documentation ownership', () => {
    it('keeps the MIT license bytes and published package claim aligned', () => {
        const rootLicense = readFileSync(new URL('../../../LICENSE', import.meta.url), 'utf8')
        const packageLicense = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')
        const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

        expect(rootLicense).toMatch(/^MIT License\n/)
        expect(packageLicense).toBe(rootLicense)
        expect(packageManifest.license).toBe('MIT')
    })

    it('keeps contributor verification and rejection boundaries discoverable', () => {
        const contributing = readFileSync(new URL('../../../CONTRIBUTING.md', import.meta.url), 'utf8')

        expect(contributing).toContain('## Verification')
        expect(contributing).toContain('```sh\nnpm test\nnpm run typecheck\nnpm run lint:docs\nnpm run lint:markdown\nnpm run lint:links\nnpm run lint:supply-chain\n```')
        expect(contributing).toContain('npm run lint:docs')
        expect(contributing).toContain('## What will not be accepted')
        expect(contributing).toContain('## Governance')
        expect(contributing).not.toMatch(/Co-Authored-By|disclos(?:e|ure).*development tool/i)
    })

    it('holds the private security channel until live proof while keeping response policy explicit', () => {
        const security = readFileSync(new URL('../../../SECURITY.md', import.meta.url), 'utf8')

        expect(security).toContain('cockpit:operator-evidence private-reporting-channel=pending')
        expect(security).not.toContain('Use the private reporting form')
        expect(security).toContain('| Acknowledgement | within 7 days |')
        expect(security).toContain('**90 days**')
        expect(security).toContain('## Consumer-identifying leaks')
    })

    it('keeps pre-publication wording only where the release checklist lists it, and nowhere once the package is public', () => {
        const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
        const checklist = readFileSync(new URL('../../../docs/contributing/releasing.md', import.meta.url), 'utf8')
        // The checklist itself, the changelogs, and the adopt skill regenerated from its listed source.
        const exempt = /^(?:docs\/contributing\/releasing\.md|skills\/adopt-cockpit\/SKILL\.md|\.changeset\/.*|(?:.*\/)?CHANGELOG\.md)$/
        const pending = [...trackedDocumentation(), 'llms.txt'].filter(path => !exempt.test(path)
            && PRE_PUBLICATION.test(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')))
        if (manifest.private !== true) {
            expect(pending).toEqual([])
            return
        }
        const item = /^- \*\*Pre-publication wording:\*\*[^\n]*(?:\n {2}[^\n]*)*/m.exec(checklist)?.[0] ?? ''
        expect(pending).toContain('README.md')
        expect(pending.filter(path => !item.includes(`\`${path}\``))).toEqual([])
    })

    it('points the llms.txt agent index only at tracked pages, starting with the agent adoption guide', () => {
        const index = readFileSync(new URL('../../../llms.txt', import.meta.url), 'utf8')
        const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0'))
        const links = [...index.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]!)
        const prefix = 'https://raw.githubusercontent.com/b0dea/cockpit/main/'

        expect(index).toMatch(/^# cockpit\n\n> \S/)
        expect(links[0]).toBe(`${prefix}docs/agent-adoption.md`)
        for (const link of links) {
            expect(link.startsWith(prefix), link).toBe(true)
            expect(tracked.has(link.slice(prefix.length)), link).toBe(true)
        }
    })

    it('points installed surfaces and CLI text at the installed guide, naming sections that exist', () => {
        const shipped = shippedGuidePages()
        const sources = trackedFiles().filter((path) => path.startsWith('packages/cockpit/surfaces/')
            || /^packages\/cockpit\/src\/.*\.ts$/.test(path) && !path.endsWith('.test.ts') && !path.includes('/test-support/'))
        let sections = 0
        for (const path of [...sources, ADOPTION_SKILL]) {
            const text = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8').replace(/\s+/g, ' ').replaceAll('*', '')
            if (path !== ADOPTION_SKILL) expect(text.match(PUBLIC_GUIDE), path).toBeNull()
            for (const match of text.matchAll(INSTALLED_GUIDE)) {
                const page = match[1]!.replace(/[.:;]$/, '')
                expect(shipped.has(page), `${path} names ${page}, which the package does not ship`).toBe(true)
                const before = text.slice(0, match.index).replace(/`$/, '')
                if (!before.endsWith(' section of ')) continue
                const lead = before.slice(0, -' section of '.length)
                expect(headings(page).some((heading) => lead.endsWith(heading)), `${path}: no ${page} heading ends "${lead.slice(-60)}"`).toBe(true)
                sections += 1
            }
        }
        expect(sections, 'a section check over no references passes vacuously').toBeGreaterThan(3)
    })

    it('sends the adoption skill to the public guide only for what precedes the install', () => {
        const skill = readFileSync(new URL(`../../../${ADOPTION_SKILL}`, import.meta.url), 'utf8')
        const tracked = new Set(trackedFiles())
        const prefix = 'https://github.com/b0dea/cockpit/blob/main/'
        const links = skill.match(PUBLIC_GUIDE) ?? []

        const text = skill.replace(/\s+/g, ' ')
        expect(text).toContain('`./node_modules/@b00dea/cockpit/docs/agent-adoption.md`')
        // Before the install the same page is in the package tarball, which works while the repository is private.
        expect(text).toContain('`package/docs/agent-adoption.md` inside the `.tgz`')
        expect(links).toEqual([`${prefix}docs/agent-adoption.md`])
        for (const link of links) expect(tracked.has(link.slice(prefix.length).split('#')[0]!), link).toBe(true)
    })

    it('routes every public policy and documentation page to an owner through the catch-all rule', () => {
        const tracked = trackedDocumentation()
        expect(PUBLIC_POLICIES.every((path) => tracked.includes(path))).toBe(true)
        const rules = readFileSync(new URL('../../../.github/CODEOWNERS', import.meta.url), 'utf8').split('\n')
            .map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
        // GitHub applies the last matching rule, so the catch-all must come first to leave later rules effective.
        expect(rules[0]).toMatch(/^\*\s+@[A-Za-z0-9][A-Za-z0-9-]*$/)
    })
})
