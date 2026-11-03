// The documentation checks no generic tool knows how to make: structured `cockpit:ref` targets,
// diagnostic codes the docs name, glossary links and the completeness of the two docs indexes.
// Markdown structure is markdownlint's (`npm run lint:markdown`) and links are lychee's
// (`npm run lint:links`).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { commandGroups, commands } from '../packages/cockpit/src/command-table.js'

export const mechanism = {
    id: 'documentation-checks',
    module: 'scripts/docs-lint.ts',
    exports: ['ROOT', 'walkMarkdownProse', 'repositoryAuthority', 'lintDocumentation'],
}

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INDEXES = { consumer: 'docs/README.md', contributor: 'docs/contributing/README.md' } as const
// The consumer paths docs may name with `cockpit:ref consumer=`: files cockpit reads or writes in a
// consumer's cockpit, not in this repository.
const CONSUMER_PATHS = new Set(['cockpit.toml'])

export interface Diagnostic { readonly path: string; readonly line: number; readonly code: string; readonly message: string }
export interface ProseLine { readonly line: number; readonly prose: string; readonly comments: readonly string[] }
export interface MarkdownLink { readonly line: number; readonly label: string; readonly target: string; readonly index: number; readonly end: number }
export interface WalkedMarkdown {
    readonly lines: readonly ProseLine[]
    readonly fences: readonly Readonly<{ line: number; info: string }>[]
    readonly links: readonly MarkdownLink[]
}

/** The visible prose of a page, line by line: fenced code and front matter removed, HTML comments lifted out. */
export function walkMarkdownProse(body: string): WalkedMarkdown {
    const lines: ProseLine[] = []
    const fences: { line: number; info: string }[] = []
    const links: MarkdownLink[] = []
    const rows = body.split(/\r?\n/)
    let fence: string | undefined
    const start = rows[0] === '---' ? rows.indexOf('---', 1) + 1 : 0
    let comment: { line: number; text: string } | undefined
    for (let index = start; index < rows.length; index += 1) {
        const number = index + 1
        let text = rows[index]!
        const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(text)
        if (fence !== undefined) {
            if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = undefined
            continue
        }
        if (marker && comment === undefined) {
            fence = marker[1]!
            fences.push({ line: number, info: marker[2]!.trim() })
            continue
        }
        const comments: string[] = []
        let prose = ''
        while (text !== '') {
            if (comment) {
                const close = text.indexOf('-->')
                comment.text += ` ${close === -1 ? text : text.slice(0, close)}`
                if (close === -1) { text = ''; break }
                text = text.slice(close + 3)
                const owner = lines.find(row => row.line === comment!.line)
                const done = comment.text.trim().replace(/\s+/g, ' ')
                if (owner) (owner.comments as string[]).push(done)
                else comments.push(done)
                comment = undefined
                continue
            }
            const open = text.indexOf('<!--')
            if (open === -1) { prose += text; break }
            prose += text.slice(0, open)
            comment = { line: number, text: '' }
            text = text.slice(open + 4)
        }
        lines.push({ line: number, prose, comments })
        const visible = prose.replace(/`+[^`]*`+/g, span => ' '.repeat(span.length))
        for (const match of visible.matchAll(/\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g)) {
            links.push({ line: number, label: match[1]!, target: match[2]!, index: match.index, end: match.index + match[0].length })
        }
    }
    if (comment) throw new Error(`HTML comment opened on line ${comment.line} is not closed`)
    return { lines, fences, links }
}

const headingAnchor = (heading: string) => heading.trim().toLowerCase().replace(/[`*~]/g, '').replace(/[^a-z0-9 _-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')

function schemaFields(schema: unknown, prefix = ''): string[] {
    const node = schema as { properties?: Record<string, unknown>; items?: unknown }
    if (node?.items !== undefined) return schemaFields(node.items, `${prefix}[]`)
    return Object.entries(node?.properties ?? {}).flatMap(([key, child]) => {
        const path = prefix === '' ? key : `${prefix}.${key}`
        return [path, ...schemaFields(child, path)]
    })
}

export interface Authority {
    /** Repository files: tracked, or untracked and not ignored. */
    readonly files: ReadonlySet<string>
    /** UPPER_SNAKE identifiers defined in tracked source outside docs and tests. */
    readonly identifiers: ReadonlySet<string>
    readonly commands: ReadonlySet<string>
    readonly schemaFields: ReadonlySet<string>
}

export function repositoryAuthority(root: string): Authority {
    // Untracked files that are not ignored count, so a check run before the commit sees what it will hold.
    const files = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0').filter(Boolean))
    const identifiers = new Set<string>()
    for (const path of files) {
        if (path.endsWith('.md') || /\.test\.[cm]?[jt]s$/.test(path) || path.startsWith('packages/cockpit/test-support/')) continue
        let text: string
        try { text = readFileSync(posix.join(root, path), 'utf8') } catch (error) {
            // A tracked path removed from the working tree, or a submodule directory, defines nothing.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EISDIR') continue
            throw error
        }
        for (const match of text.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)) identifiers.add(match[0])
    }
    const schema = JSON.parse(readFileSync(posix.join(root, 'packages/cockpit/cockpit.schema.json'), 'utf8')) as unknown
    return { files, identifiers, commands: new Set([...commands.map(command => command.name), ...commandGroups.map(group => group.name)]),
        schemaFields: new Set(schemaFields(schema)) }
}

/** Every finding in the given pages. `documents` maps a repository path to its bytes. */
export function lintDocumentation(documents: ReadonlyMap<string, string>, authority: Authority): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const report = (path: string, line: number, code: string, message: string) => diagnostics.push({ path, line, code, message })
    const walked = new Map<string, WalkedMarkdown>()
    for (const [path, body] of documents) {
        try { walked.set(path, walkMarkdownProse(body)) } catch (error) { report(path, 1, 'DOC031_UNCLOSED_COMMENT', (error as Error).message) }
    }
    const concepts = (walked.get('docs/concepts.md')?.lines ?? []).flatMap(row => {
        const heading = /^##\s+(.+?)\s*$/.exec(row.prose)
        return heading ? [{ term: heading[1]!.replace(/[`*_]/g, ''), anchor: headingAnchor(heading[1]!) }] : []
    })
    const terms = concepts.map(concept => concept.term.toLowerCase())
    for (const term of new Set(terms.filter((term, index) => terms.indexOf(term) !== index))) report('docs/concepts.md', 1, 'DOC062_CONCEPT_DUPLICATE', term)

    for (const [path, page] of walked) {
        const mentioned = new Set<string>()
        for (const row of page.lines) {
            for (const comment of row.comments.filter(text => text.startsWith('cockpit:ref'))) {
                const match = /^cockpit:ref (path|schema|consumer|command)=(\S+(?: [a-z][a-z0-9-]*)?)$/.exec(comment)
                const [kind, value] = match ? [match[1], match[2]!] : [undefined, comment]
                const known = kind === 'path' ? authority.files.has(value)
                    : kind === 'schema' ? authority.schemaFields.has(value)
                        : kind === 'consumer' ? CONSUMER_PATHS.has(value)
                            : kind === 'command' && authority.commands.has(value)
                if (!known) report(path, row.line, 'DOCEV050_NAMED_REFERENCE_MISSING', kind === undefined ? `malformed structured reference: ${comment}` : `${kind}=${value}`)
            }
            // A code the docs name but nothing outside docs and tests defines sends the reader after
            // a diagnostic cockpit can never print.
            for (const span of row.prose.matchAll(/(`+)([^`]+)\1/g)) {
                const value = span[2]!.trim()
                if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(value) && !authority.identifiers.has(value)) report(path, row.line, 'DOC071_CODE_UNDEFINED', value)
            }
            if (path === 'docs/concepts.md' || /^ {0,3}\[[^\]]+\]:/.test(row.prose)) continue
            // The first mention of a glossary term on a page links to its definition; later
            // mentions are free, because a link on every mention is noise to the reader.
            const rowLinks = page.links.filter(link => link.line === row.line)
            for (const concept of concepts) {
                if (mentioned.has(concept.term)) continue
                const escaped = concept.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                // A term inside a link destination is part of a path or anchor, not a mention.
                const mention = [...row.prose.matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))].find(found =>
                    !rowLinks.some(link => found.index > link.index + link.label.length && found.index < link.end))
                if (!mention) continue
                mentioned.add(concept.term)
                const expected = `${posix.relative(posix.dirname(path), 'docs/concepts.md') || 'concepts.md'}#${concept.anchor}`
                const link = rowLinks.find(candidate => mention.index > candidate.index && mention.index + mention[0].length <= candidate.index + 1 + candidate.label.length)
                if (link?.target !== expected) report(path, row.line, 'DOC067_CONCEPT_UNLINKED', concept.term)
            }
        }
    }

    // Each docs page is listed by the index of its estate, and an index never links across estates.
    for (const [estate, index] of Object.entries(INDEXES)) {
        const page = walked.get(index)
        if (!page) { report(index, 1, 'DOC060_ESTATE_INDEX_MISSING', `${estate} documentation has no index`); continue }
        const contributor = (target: string) => target.startsWith('docs/contributing/')
        const linked = new Set<string>()
        for (const [source, walk] of walked) {
            if (!source.startsWith('docs/') || contributor(source) !== (estate === 'contributor') || !source.endsWith('README.md')) continue
            for (const link of walk.links) {
                if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(link.target)) continue
                const target = posix.normalize(posix.join(posix.dirname(source), link.target.split('#', 1)[0]!))
                if (target.startsWith('docs/') && contributor(target) !== (estate === 'contributor')) report(source, link.line, 'DOC061_ESTATE_CROSS_LINK', link.target)
                linked.add(target)
            }
        }
        for (const path of documents.keys()) {
            if (path.startsWith('docs/') && path.endsWith('.md') && contributor(path) === (estate === 'contributor') && path !== index && !linked.has(path)) {
                report(path, 1, 'DOC068_PAGE_UNINDEXED', `no ${estate} index page links to ${path}`)
            }
        }
    }
    return diagnostics
}

function main(): void {
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    if (files.length === 0) throw new Error('[DOC002_EMPTY_CORPUS] Git enumerated no Markdown paths')
    const documents = new Map(files.map(path => [path, readFileSync(posix.join(ROOT, path), 'utf8')]))
    const diagnostics = lintDocumentation(documents, repositoryAuthority(ROOT))
    for (const row of diagnostics) console.error(`docs-lint: ${row.path}:${row.line} [${row.code}] ${row.message}`)
    console.log(`docs-lint: checked ${documents.size} Markdown files, ${diagnostics.length} findings`)
    if (diagnostics.length > 0) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try { main() } catch (error) {
        console.error(`docs-lint: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
    }
}
