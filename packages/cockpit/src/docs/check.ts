// `cockpit docs check`: the living documents and decision records [docs] declares, checked against
// each repository's files and history. It reads and runs read-only Git; it writes nothing.
import { lstatSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { readBoundedFile } from '../bounded-read.js'
import { loadCockpitConfig } from '../config/load.js'
import { ENVIRONMENT_CODES, errorCause, type Diagnostic, type ExecutionStep } from '../environment/contract.js'
import { gitRepositoryRefusal } from '../environment/git-observation.js'
import { redactSensitiveMessage } from '../environment/sensitive.js'
import { createGitRunner, loadServedSiblings, missingServedCheckout, type GitRunner } from '../environment/sibling-checkouts.js'
import { refusalOutcome } from '../refusal.js'
import { splitRepositoryPath } from '../repository-path.js'
import { scopeMatcher } from '../work-orders/contract.js'
import { inspectDecisionRecords } from './decisions.js'
import { walkMarkdownProse } from './markdown.js'
import { historicalMakeTargets, makeTargets, parseRemovedPaths, staleReferences, type LivingDocument } from './references.js'

interface DocsCheckInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
}

interface DocsCheckOutcome {
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
}

type Execute = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>

const GIT_TIMEOUT_MS = 60_000
// The executor's ceiling; a history longer than this is refused rather than read in part.
const GIT_OUTPUT_LIMIT = 16_777_216
const DOCUMENT_LIMIT = 4_194_304
const MARKDOWN = /\.(?:md|markdown|mdx)$/i
const MAKEFILE = /(?:^|\/)(?:GNUmakefile|[Mm]akefile|[^/]+\.mk)$/
const MAKEFILE_PATHSPECS = [':(glob)**/GNUmakefile', ':(glob)**/Makefile', ':(glob)**/makefile', ':(glob)**/*.mk']

class EvidenceUnavailable extends Error {}

async function git(runner: GitRunner, root: string, args: readonly string[]): Promise<string> {
    const command = `git -C ${root} ${args.join(' ')}`
    const ran = await runner.run(root, `git:docs-check:${args[0]}`, args, { timeoutMs: GIT_TIMEOUT_MS, stdoutLimitBytes: GIT_OUTPUT_LIMIT })
    if (ran.kind === 'complete') return ran.stdout
    if (ran.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED) {
        // A repository made with `sibling add --create` has no commit yet, so it has no history to read.
        if (args[0] === 'log' && /does not have any commits yet/.test(ran.stderr)) return ''
        const refused = gitRepositoryRefusal(Buffer.from(ran.stderr))
        throw new EvidenceUnavailable(refused.kind === 'not-a-repository' ? `${root} is not a Git repository` : `${command}: ${redactSensitiveMessage(refused.reason) ?? 'Git printed text that could not be redacted, so it is withheld'}`)
    }
    throw new EvidenceUnavailable(ran.code === ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT
        ? `${command} printed more than ${GIT_OUTPUT_LIMIT} bytes` : `${command} did not complete (${ran.detail})`)
}

function read(root: string, path: string): string {
    let bytes
    try { bytes = readBoundedFile(resolve(root, path), DOCUMENT_LIMIT) } catch (error) { throw new EvidenceUnavailable(`${path} could not be read (${errorCause(error)})`) }
    if (bytes.kind === 'too-large') throw new EvidenceUnavailable(`${path} is larger than ${DOCUMENT_LIMIT} bytes`)
    // Fatal decoding throws only for invalid UTF-8.
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.bytes) } catch { throw new EvidenceUnavailable(`${path} is not valid UTF-8`) }
}

function present(root: string, path: string): boolean {
    try { lstatSync(resolve(root, path)); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false
        throw new EvidenceUnavailable(`${path} could not be inspected (${errorCause(error)})`)
    }
}

function removedPaths(output: string): ReadonlyMap<string, string | undefined> {
    try { return parseRemovedPaths(output) } catch (error) { throw new EvidenceUnavailable((error as Error).message) }
}

// `<slug>:path` names a sibling's repository; a bare path names the cockpit's own, keyed ''.
function split(reference: string): Readonly<{ repository: string; path: string }> {
    const { slug, path } = splitRepositoryPath(reference)
    return { repository: slug ?? '', path }
}

export async function runDocsCheck(input: DocsCheckInput, dependencies: Readonly<{ execute: Execute }>): Promise<DocsCheckOutcome> {
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return loaded
    const { config, source } = loaded.result
    const docs = config.docs
    if (docs === undefined) {
        return refusalOutcome('DOCS_NOT_DECLARED' satisfies typeof ENVIRONMENT_CODES.DOCS_NOT_DECLARED,
            `${source.path} has no [docs] table, so there are no living documents or decision records to check`, 'docs',
            'add a [docs] table to cockpit.toml: living = ["README.md", "docs/**/*.md"] lists the documents that must stay true, and the optional decisions = "docs/adr" and decisions_index = "docs/adr/README.md" name the decision records and their index; then rerun npx --no cockpit docs check --config <your cockpit.toml>')
    }
    const runner = await createGitRunner(input.env, dependencies.execute)
    if ('unavailable' in runner) {
        return refusalOutcome(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
            `docs check reads repository history with Git, which is unavailable: ${runner.unavailable}`, 'git',
            'install Git or put it on PATH, then rerun npx --no cockpit docs check --config <your cockpit.toml>')
    }
    const cockpitRoot = posix.dirname(source.path)
    // A sibling `cockpit use` serves from another checkout is checked there, where the stack runs it.
    const served = await loadServedSiblings(cockpitRoot, config)
    if (served.kind !== 'complete') return { status: 2, diagnostics: [served.diagnostic], result: null }
    const gone = await missingServedCheckout(served.siblings)
    if (gone) return { status: 2, diagnostics: [gone], result: null }
    const rootOf = (repository: string) => repository === '' ? cockpitRoot : served.siblings.get(repository)!.served
    const decisions = docs.decisions === undefined ? undefined : split(docs.decisions)
    const living = docs.living.map(split)
    const repositories = [...new Set([...living.map(entry => entry.repository), ...decisions ? [decisions.repository] : []])]

    const checked = await Promise.all(repositories.map(repository => checkRepository({
        repository, root: rootOf(repository), runner,
        globs: living.filter(entry => entry.repository === repository).map(entry => entry.path),
        ...decisions?.repository === repository ? { decisions: { directory: decisions.path,
            ...docs.decisions_index === undefined ? {} : { index: split(docs.decisions_index).path } } } : {},
    })))
    // Joined in declaration order, so the report does not depend on which repository Git answered first.
    const findings = checked.flatMap(row => row.findings)
    return { status: findings.length === 0 ? 0 : 2, diagnostics: findings,
        result: { repositories: checked.map(row => row.summary), findings: findings.length } }
}

async function checkRepository(input: Readonly<{
    repository: string
    root: string
    globs: readonly string[]
    decisions?: Readonly<{ directory: string; index?: string }>
    runner: GitRunner
}>): Promise<Readonly<{ summary: Readonly<Record<string, unknown>>; findings: Diagnostic[] }>> {
    const { repository, root, globs } = input
    const prefix = repository === '' ? '' : `${repository}:`
    const findings: Diagnostic[] = []
    const unavailable = (error: unknown) => {
        if (!(error instanceof EvidenceUnavailable)) throw error
        findings.push({ severity: 'error', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
            message: `the documents in ${repository === '' ? 'the cockpit repository' : `sibling ${repository}`} could not be checked: ${error.message}`,
            target: repository === '' ? 'docs' : `sibling:${repository}`,
            fix: 'fix what the message names (for a missing sibling checkout, run npx --no cockpit setup --config <your cockpit.toml>), then rerun npx --no cockpit docs check --config <your cockpit.toml>' })
    }
    let livingDocuments = 0
    let decisionFiles = 0
    try {
        // Untracked files that are not ignored count, so a document added in this change is checked before its commit.
        const [listed, history] = await Promise.all([
            git(input.runner, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
            globs.length > 0 ? Promise.all([
                git(input.runner, root, ['log', '--relative', '--format=', '--name-status', '-z', '-M', '--diff-filter=DR']),
                git(input.runner, root, ['log', '--relative', '-p', '--format=', '--no-color', '--no-ext-diff', '--no-textconv', '--', ...MAKEFILE_PATHSPECS]),
            ]) : undefined,
        ])
        const all = listed.split('\0').filter(Boolean)
        const files = new Set(all)
        const markdown = all.filter(file => MARKDOWN.test(file))
        if (history) {
            const [names, patch] = history
            for (const glob of globs) {
                if (!markdown.some(scopeMatcher([glob]))) {
                    findings.push({ severity: 'error', code: 'DOCS_DECLARATION_UNMATCHED' satisfies typeof ENVIRONMENT_CODES.DOCS_DECLARATION_UNMATCHED, target: `${prefix}${glob}`,
                        message: `[docs] living entry ${prefix}${glob} matches no Markdown file, so it checks nothing`,
                        fix: 'correct the glob under [docs] living in cockpit.toml to match the documents, or remove it; then rerun npx --no cockpit docs check --config <your cockpit.toml>' })
                }
            }
            const documents: LivingDocument[] = []
            for (const path of markdown.filter(scopeMatcher(globs)).sort()) {
                let body: string
                try { body = read(root, path) } catch (error) { unavailable(error); continue }
                // The walker throws only for an HTML comment that never closes.
                try { documents.push({ path, walked: walkMarkdownProse(body) }) } catch (error) {
                    unavailable(new EvidenceUnavailable(`${path}: ${(error as Error).message}`))
                }
            }
            livingDocuments = documents.length
            const current = makeTargets(all.filter(file => MAKEFILE.test(file)).flatMap(file => read(root, file).split('\n')))
            findings.push(...staleReferences({ repository: prefix, documents, files, targets: current, present: path => present(root, path),
                history: { removed: removedPaths(names), targets: historicalMakeTargets(patch) } }))
        }
        if (input.decisions) {
            const directory = posix.normalize(input.decisions.directory).replace(/\/$/, '')
            const index = input.decisions.index === undefined ? undefined : posix.normalize(input.decisions.index)
            const records = markdown.filter(file => posix.dirname(file) === directory)
            const missing = records.length === 0 ? { target: directory, message: `[docs] decisions ${prefix}${directory} holds no Markdown file` }
                : index !== undefined && !files.has(index) ? { target: index, message: `[docs] decisions_index ${prefix}${index} does not exist` } : undefined
            if (missing) {
                findings.push({ severity: 'error', code: 'DOCS_DECLARATION_UNMATCHED' satisfies typeof ENVIRONMENT_CODES.DOCS_DECLARATION_UNMATCHED,
                    target: `${prefix}${missing.target}`, message: `${missing.message}, so it checks nothing`,
                    fix: 'correct decisions or decisions_index under [docs] in cockpit.toml to the directory of decision records and the file that lists them, or remove the key; then rerun npx --no cockpit docs check --config <your cockpit.toml>' })
            } else {
                decisionFiles = records.length
                findings.push(...inspectDecisionRecords({ repository: prefix, directory,
                    files: new Map(records.map(name => [posix.basename(name), read(root, name)])),
                    ...index === undefined ? {} : { index: { path: index, body: read(root, index) } } }))
            }
        }
    } catch (error) { unavailable(error) }
    return { summary: { repository: repository === '' ? '.' : repository, root, livingDocuments, decisionFiles }, findings }
}
