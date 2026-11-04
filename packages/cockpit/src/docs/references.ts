// Stale references in living documents: a path or `make` target a document cites that the
// repository once had and has since removed. Keying on history is the whole precision story: a
// backlog full of proposals ("add `make park`") names things that never existed, and those are
// left alone, while `make publish` after its target was deleted is exactly the rot to report. No
// allowlist is needed, and a link that never resolved is a link checker's business.
import { posix } from 'node:path'
import type { Diagnostic, ENVIRONMENT_CODES } from '../environment/contract.js'
import { resolveLinkTarget, type WalkedMarkdown } from './markdown.js'

export interface RepositoryHistory {
    /** Each path a commit deleted or renamed away, newest first, mapped to its new name for a rename. */
    readonly removed: ReadonlyMap<string, string | undefined>
    /** Every make target any version of a Makefile defined. */
    readonly targets: ReadonlySet<string>
}

export interface LivingDocument {
    readonly path: string
    readonly walked: WalkedMarkdown
}

/** `git log --format= --name-status -z -M --diff-filter=DR` output, newest commit first. */
export function parseRemovedPaths(output: string): Map<string, string | undefined> {
    const removed = new Map<string, string | undefined>()
    const tokens = output.split('\0').filter(token => token !== '')
    for (let index = 0; index < tokens.length;) {
        const status = tokens[index++]!
        if (status === 'D') {
            const path = tokens[index++]!
            if (!removed.has(path)) removed.set(path, undefined)
        } else if (/^R\d*$/.test(status)) {
            const from = tokens[index++]!
            const to = tokens[index++]!
            if (!removed.has(from)) removed.set(from, to)
        } else throw new Error(`unexpected git name-status record ${JSON.stringify(status)}`)
    }
    return removed
}

const RULE = /^([^\s:#=$][^:#=$]*?)\s*::?(?!=)/

/** The targets the given Makefile lines define, including .PHONY names; special and pattern targets are skipped. */
export function makeTargets(lines: Iterable<string>): Set<string> {
    const targets = new Set<string>()
    for (const line of lines) {
        const phony = /^\.PHONY\s*:(.*)$/.exec(line)
        const names = phony ? phony[1]! : RULE.exec(line)?.[1]
        for (const name of names?.trim().split(/\s+/) ?? []) {
            if (name !== '' && !name.startsWith('.') && !name.includes('%')) targets.add(name)
        }
    }
    return targets
}

/** The targets ever defined, from `git log -p` over the Makefiles: every line was added once. */
export function historicalMakeTargets(patch: string): Set<string> {
    return makeTargets(patch.split('\n').filter(line => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line)).map(line => line.slice(1)))
}

const SHELL_FENCES = new Set(['', 'sh', 'bash', 'shell', 'zsh', 'console', 'terminal', 'shell-session'])
const PATH_SPAN = /^[A-Za-z0-9._@+~-][A-Za-z0-9._@+~/-]*$/

// `make a b` cites a and b; `make -C dir x` or `make -f other.mk x` cites another Makefile, so not x.
function citedTargets(text: string): string[] {
    const targets: string[] = []
    for (const match of text.matchAll(/(?:^|[\s;&|(`$])make((?:[ \t]+[^\s;&|)`]+)*)/g)) {
        const words = match[1]!.trim().split(/\s+/).filter(Boolean)
        if (words.some(word => /^-(?:C|f)|^--(?:directory|file|makefile)\b/.test(word))) continue
        for (const word of words) {
            if (word.startsWith('-') || word.includes('=')) continue
            if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(word)) break
            targets.push(word)
        }
    }
    return targets
}

function citedPath(document: string, raw: string, relativeToDocument: boolean): string | undefined {
    const value = raw.trim().replace(/^<|>$/g, '')
    const relative = relativeToDocument || value.startsWith('./') || value.startsWith('../')
    const resolved = resolveLinkTarget(relative ? posix.dirname(document) : '', value)
    return resolved === undefined || resolved === '.' || resolved.startsWith('../') ? undefined : resolved
}

// Every directory above the given files: `a/b/c.md` contributes `a` and `a/b`.
const ancestors = (files: Iterable<string>) => new Set([...files].flatMap(file => file.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))))

/**
 * The stale references in the given documents. `files` are the repository's files now; a cited
 * directory counts as present while any file is under it.
 */
export function staleReferences(input: Readonly<{
    repository: string
    documents: readonly LivingDocument[]
    files: ReadonlySet<string>
    targets: ReadonlySet<string>
    history: RepositoryHistory
    /** Whether the path is on disk; an ignored file is absent from `files` but not removed. */
    present: (path: string) => boolean
}>): Diagnostic[] {
    const findings: Diagnostic[] = []
    const directories = ancestors(input.files)
    const exists = (path: string) => input.files.has(path) || directories.has(path)
    const removedDirectories = ancestors(input.history.removed.keys())
    // Follow renames to where the content lives now; a chain that ends in a deletion is a removal.
    const successor = (path: string): string | undefined => {
        const seen = new Set<string>()
        let current = path
        while (input.history.removed.has(current) && !seen.has(current)) {
            seen.add(current)
            const next = input.history.removed.get(current)
            if (next === undefined) return undefined
            if (exists(next)) return next
            current = next
        }
        return undefined
    }
    for (const document of input.documents) {
        const reported = new Set<string>()
        const start = findings.length
        const where = (line: number) => `${input.repository}${document.path}:${line}`
        const cite = (line: number, path: string | undefined) => {
            if (path === undefined || exists(path) || !input.history.removed.has(path) && !removedDirectories.has(path) || input.present(path)) return
            const key = `${line}\0${path}`
            if (reported.has(key)) return
            reported.add(key)
            const renamed = successor(path)
            findings.push({ severity: 'error', code: 'DOCS_REFERENCE_REMOVED' satisfies typeof ENVIRONMENT_CODES.DOCS_REFERENCE_REMOVED, target: where(line),
                message: renamed === undefined
                    ? `${where(line)} cites ${path}, which the repository history removed`
                    : `${where(line)} cites ${path}, which the repository history renamed to ${renamed}`,
                fix: 'cite the path that replaced it (a rename is named in the message), or rewrite or delete the sentence if what it described is gone; then rerun npx --no cockpit docs check --config <your cockpit.toml>' })
        }
        const citeTargets = (line: number, text: string) => {
            for (const target of citedTargets(text)) {
                const key = `${line}\0make ${target}`
                if (input.targets.has(target) || !input.history.targets.has(target) || reported.has(key)) continue
                reported.add(key)
                findings.push({ severity: 'error', code: 'DOCS_TARGET_REMOVED' satisfies typeof ENVIRONMENT_CODES.DOCS_TARGET_REMOVED, target: where(line),
                    message: `${where(line)} runs make ${target}, a target the Makefiles once defined and no longer do`,
                    fix: 'cite the target or command that replaced it, or rewrite or delete the sentence if the step is gone; then rerun npx --no cockpit docs check --config <your cockpit.toml>' })
            }
        }
        for (const row of document.walked.lines) {
            for (const span of row.prose.matchAll(/(`+)([^`]+)\1/g)) {
                const value = span[2]!.trim()
                if (PATH_SPAN.test(value)) cite(row.line, citedPath(document.path, value, false))
                else citeTargets(row.line, value)
            }
        }
        for (const link of document.walked.links) cite(link.line, citedPath(document.path, link.target, true))
        for (const row of document.walked.fencedLines) {
            if (SHELL_FENCES.has(row.info.split(/\s+/, 1)[0]!.toLowerCase())) citeTargets(row.line, row.text.replace(/^\s*[$%>#]\s+/, ''))
        }
        // Spans, links and fences are read in separate passes; the report follows the document.
        const line = (finding: Diagnostic) => Number(finding.target!.slice(finding.target!.lastIndexOf(':') + 1))
        findings.splice(start, findings.length - start, ...findings.slice(start).sort((left, right) => line(left) - line(right)))
    }
    return findings
}
