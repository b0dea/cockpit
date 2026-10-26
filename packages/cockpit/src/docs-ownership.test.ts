import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classifyMarkdownPath, resolveCodeOwners } from '../../../scripts/docs-lint.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PUBLIC_POLICIES = [
    'README.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'CHANGELOG.md',
] as const

function trackedDocumentation(): string[] {
    return execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' })
        .split('\0')
        .filter((path) => path !== '' && classifyMarkdownPath(path) !== 'fixture')
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
        expect(contributing).toContain('```sh\nnpm test\nnpm run typecheck\nnpm run lint:docs\nnpm run lint:supply-chain\n```')
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

    it('owns every public root policy and the public documentation tree', () => {
        const tracked = trackedDocumentation()
        const paths = [...PUBLIC_POLICIES, ...tracked.filter((path) => path.startsWith('docs/'))]
        const codeOwners = readFileSync(new URL('../../../.github/CODEOWNERS', import.meta.url), 'utf8')

        expect(PUBLIC_POLICIES.every((path) => tracked.includes(path))).toBe(true)
        expect(paths.some((path) => path.startsWith('docs/'))).toBe(true)
        expect(resolveCodeOwners(paths, codeOwners)).toEqual(
            paths.map((path) => ({ owners: ['@b0dea'], path })),
        )
    })

    it('resolves a real tracked page through the existing repository wildcard', () => {
        const paths = trackedDocumentation().filter((path) => classifyMarkdownPath(path) === 'human')
        const codeOwners = readFileSync(new URL('../../../.github/CODEOWNERS', import.meta.url), 'utf8')

        expect(paths.length, 'an ownership scan over no human documentation passes vacuously').toBeGreaterThan(0)
        expect(resolveCodeOwners([paths[0]], codeOwners)).toEqual([
            { owners: ['@b0dea'], path: paths[0] },
        ])
    })

    it('resolves every tracked page through its effective owner', () => {
        const paths = trackedDocumentation()
        const codeOwners = readFileSync(new URL('../../../.github/CODEOWNERS', import.meta.url), 'utf8')

        expect(paths.length, 'an ownership scan over no documentation passes vacuously').toBeGreaterThan(8)
        expect(resolveCodeOwners(paths, codeOwners)).toEqual(
            paths.map((path) => ({ owners: ['@b0dea'], path })),
        )
    })

    it('uses the last matching rule when patterns overlap', () => {
        const codeOwners = '* @default\ndocs/** @documentation\n'

        expect(resolveCodeOwners(['docs/contributing/style.md'], codeOwners)).toEqual([
            { owners: ['@documentation'], path: 'docs/contributing/style.md' },
        ])
    })

    it('fails closed on an empty corpus, an unmatched page, or unsupported syntax', () => {
        expect(() => resolveCodeOwners([], '* @default\n')).toThrowError(/\[DOCOWN001_EMPTY_CORPUS\]/)
        expect(() => resolveCodeOwners(['README.md'], 'docs\/** @documentation\n')).toThrowError(
            /\[DOCOWN003_UNOWNED\]/,
        )
        expect(() => resolveCodeOwners(['README.md'], '!README.md @default\n')).toThrowError(
            /\[DOCOWN002_UNSUPPORTED_SYNTAX\]/,
        )
    })
})
