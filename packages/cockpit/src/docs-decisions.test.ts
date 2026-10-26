import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CONTRACT_PATH = /^docs\/contributing\/decisions\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.md$/
const INDEX_PATH = 'docs/contributing/decisions/README.md'
const INDEX_URL = new URL('../../../docs/contributing/decisions/README.md', import.meta.url)
const EXPECTED_CONTRACTS = new Map([
    ['docs/contributing/decisions/installed-capabilities.md', {
        sections: ['Observation and execution', 'Generated ownership', 'Framework and overlays'],
        title: 'Installed capabilities',
    }],
    ['docs/contributing/decisions/operator-paths.md', { sections: [], title: 'Operator paths' }],
])
const HISTORY_MARKERS = /\bHistorical\b|^# Decision \d+|^\*\*(?:Date|Status):\*\*/im

interface ContractRecord { body: string; path: string }
interface InspectedContract { path: string; slug: string; title: string }

function inspectContracts(records: ContractRecord[]): InspectedContract[] {
    if (records.length === 0) throw new Error('[CONTRACT_EMPTY_CORPUS]')

    const slugs = new Set<string>()
    return records.map(({ body, path }) => {
        const pathMatch = CONTRACT_PATH.exec(path)
        if (pathMatch === null) throw new Error(`[CONTRACT_PATH_INVALID] ${path}`)
        const slug = pathMatch[1]
        if (slugs.has(slug)) throw new Error(`[CONTRACT_SLUG_DUPLICATE] ${slug}`)
        slugs.add(slug)

        const expected = EXPECTED_CONTRACTS.get(path)
        if (expected === undefined) throw new Error(`[CONTRACT_UNDECLARED] ${path}`)
        const title = /^# (.+)$/m.exec(body)?.[1]
        if (title !== expected.title) throw new Error(`[CONTRACT_TITLE_INVALID] ${path}`)
        for (const section of expected.sections) {
            if (!new RegExp(`^## ${section}$`, 'm').test(body)) {
                throw new Error(`[CONTRACT_SECTION_MISSING] ${path} ${section}`)
            }
        }
        if (HISTORY_MARKERS.test(body)) throw new Error(`[CONTRACT_HISTORY_DISCLOSURE] ${path}`)
        return { path, slug, title }
    })
}

function trackedContractPaths(): string[] {
    return execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'docs/contributing/decisions/*.md'],
        { cwd: ROOT, encoding: 'utf8' },
    ).split('\0').filter(Boolean).sort()
}

function trackedContractRecords(paths = trackedContractPaths()): ContractRecord[] {
    return paths.filter((path) => path !== INDEX_PATH).map((path) => ({
        body: readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'),
        path,
    }))
}

function assertAuthorityPolicy(index: string): void {
    if (!/^# Normative contracts$/m.test(index)) throw new Error('[CONTRACT_INDEX_TITLE_INVALID]')
    for (const path of EXPECTED_CONTRACTS.keys()) {
        const basename = path.slice(path.lastIndexOf('/') + 1)
        if (!index.includes(`](${basename})`)) throw new Error(`[CONTRACT_INDEX_LINK_MISSING] ${basename}`)
    }
    if (!/update(?:d|s)? in place/i.test(index) || !/CHANGELOG/i.test(index)) {
        throw new Error('[CONTRACT_UPDATE_POLICY_MISSING]')
    }
    if (HISTORY_MARKERS.test(index) || /append-only|supersed(?:e|ed|ing)|archiv(?:e|ed) record|records? (?:are|were) archived/i.test(index)) {
        throw new Error('[CONTRACT_INDEX_HISTORY_DISCLOSURE]')
    }
}

describe('normative contract detector controls', () => {
    it('rejects numbered, malformed, duplicate, and undeclared filenames', () => {
        expect(() => inspectContracts([{ body: '# Operator paths\n', path: 'docs/contributing/decisions/0007-example-contract.md' }]))
            .toThrowError(/\[CONTRACT_PATH_INVALID\]/)
        expect(() => inspectContracts([
            { body: '# Operator paths\n', path: 'docs/contributing/decisions/operator-paths.md' },
            { body: '# Operator paths\n', path: 'docs/contributing/decisions/operator-paths.md' },
        ])).toThrowError(/\[CONTRACT_SLUG_DUPLICATE\]/)
        expect(() => inspectContracts([{ body: '# Extra\n', path: 'docs/contributing/decisions/extra.md' }]))
            .toThrowError(/\[CONTRACT_UNDECLARED\]/)
    })

    it('rejects a missing required heading or historical metadata', () => {
        const installed = '# Installed capabilities\n\n## Observation and execution\n\n## Generated ownership\n\n## Framework and overlays\n'
        expect(() => inspectContracts([{
            body: installed.replace('## Generated ownership\n', ''),
            path: 'docs/contributing/decisions/installed-capabilities.md',
        }])).toThrowError(/\[CONTRACT_SECTION_MISSING\]/)
        expect(() => inspectContracts([{
            body: '# Operator paths\n\n**Date:** 2000-01-01\n',
            path: 'docs/contributing/decisions/operator-paths.md',
        }])).toThrowError(/\[CONTRACT_HISTORY_DISCLOSURE\]/)
    })

    it('rejects an index missing current authority or migration policy', () => {
        const links = '[Operator paths](operator-paths.md)\n[Installed capabilities](installed-capabilities.md)'
        expect(() => assertAuthorityPolicy(`# Contracts\n${links}\nContracts update in place; migrations appear in CHANGELOG.`))
            .toThrowError(/\[CONTRACT_INDEX_TITLE_INVALID\]/)
        expect(() => assertAuthorityPolicy(`# Normative contracts\n${links}`))
            .toThrowError(/\[CONTRACT_UPDATE_POLICY_MISSING\]/)
        expect(() => assertAuthorityPolicy(`# Normative contracts\n${links}\nContracts update in place; migrations appear in CHANGELOG. Earlier records are archived.`))
            .toThrowError(/\[CONTRACT_INDEX_HISTORY_DISCLOSURE\]/)
    })
})

describe('published normative contracts', () => {
    it('contains only the index and the two current stable contracts', () => {
        expect(trackedContractPaths()).toEqual([INDEX_PATH, ...EXPECTED_CONTRACTS.keys()].sort())
    })

    it('keeps the current operator and installed-capability contracts structurally complete', () => {
        expect(inspectContracts(trackedContractRecords())).toEqual([
            { path: 'docs/contributing/decisions/installed-capabilities.md', slug: 'installed-capabilities', title: 'Installed capabilities' },
            { path: 'docs/contributing/decisions/operator-paths.md', slug: 'operator-paths', title: 'Operator paths' },
        ])
    })

    it('indexes current authority without publishing development chronology', () => {
        assertAuthorityPolicy(readFileSync(INDEX_URL, 'utf8'))
    })
})
