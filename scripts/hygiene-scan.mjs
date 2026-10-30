import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const IMPLEMENTED_MECHANISMS = Object.freeze([
    {
        id: 'tree-hygiene',
        exports: [
            'ROOT_URL',
            'ROOT',
            'SITE_NEEDLES',
            'INTERNAL',
            'FIXTURE',
            'ALLOWED',
            'universalPatterns',
            'siteTerms',
            'hasInternal',
            'buildNeedle',
            'coverage',
            'scanText',
            'scanPathText',
            'scanPublicationPathText',
            'commitMessageText',
            'scanCommitMessage',
            'trackedContents',
            'untrackedPaths',
            'scanGitHistory',
        ],
    },
])

// Tests and commit hooks share these rules so index and working-tree checks cannot drift.
// Plain ESM keeps mandatory hooks independent of a compiler or package-manager startup.

export const ROOT_URL = new URL('../', import.meta.url)
export const ROOT = fileURLToPath(ROOT_URL)

/** Ignored, so a clone without the deployments simply has none. One term per line. */
export const SITE_NEEDLES = 'internal/hygiene-needles.txt'
/** Present only in a checkout that holds the real material. */
export const INTERNAL = 'internal'
/** Planted synthetic identifiers: the proof the scan can fire. */
export const FIXTURE = 'fixtures/hygiene/planted-identifiers.txt'

const HISTORY_OBJECT_BYTE_LIMIT = 8 * 1024 * 1024
const HISTORY_OBJECT_COUNT_LIMIT = 100_000
const HISTORY_BATCH_OBJECT_LIMIT = 32
const HISTORY_BATCH_BYTE_LIMIT = 64 * 1024 * 1024

/**
 * Hits that are known-good. An entry is a decision with a reason beside it, and a stale entry
 * is as much a defect as a missing one.
 */
export const ALLOWED = [
    {
        file: FIXTURE,
        lineSha256: Object.freeze([
            '36fbe8260d247e3e743bf425db0d16827b87948bf5481eb143f62a42d073d613',
            'd78cff564e1206649500493b30253f46e29ff370cb6c9a250a8887ae44bcfcf7',
            '98483eb0d279881d420f335562e3f0fda0fac73b22bde33a42a20909ddb7be7c',
            '0171d2c76e0336f54ea6eb14172c724bc829737c3183036568754123979ef0a9',
            'd0c4899684496f87d4bfd5a6497c310e1454932958ecfb4330b7ba191e0e91c0',
            'f99cdd9bc6fcd7ef11ad57c10ba65555919658ca8ed12136d4b5e90e52610d7a',
            'eacc1d8cde414d4d09aaf9855d4d5369b19e33a8275b0d9de084501d6bdd7eb4',
            'af11454c4c63ffb537a66ab80bc3f10e565b761c3d97587b4807d0f2399a4789',
            '3fd629c36d7d994152965b91fb3f087e85e8394be3c69afcd250d0c228079cfe',
            'b71dfe833881c5311fed21291c6a37f0fd7e36309249f88541040fc57bf85a47',
            '210e3a440eae94af060827e5fa5c5d4cd1a75d18427fa562b33ddec7c30773d7',
            '4f1a3310c48c5b57c0cee2ef429ce134a4ad297bbc65fc2518781168abd23cf1',
            '50d783eecb15109e9c8fc24e6d9ff5229b3142bcc1bbda1190b62a669aa8ba37',
            '16e61179f4689fa7b0f291bdaf7c91299b6d07aaeef792031f062f28d2ab4dd5',
        ]),
        why: 'exact synthetic control lines; every other line is scanned normally',
    },
]

/** Rebuilt at runtime so the source of this file contains none of them. */
export function universalPatterns() {
    const paths = [
        '/Us' + 'ers/',
        '/ro' + 'ot(?:/|\\b)',
        '/var/ro' + 'ot(?:/|\\b)',
        '/ho' + 'me/[A-Za-z0-9._-]+(?:/|\\b)',
        String.raw`[A-Za-z]:[\\/]Us` + String.raw`ers[\\/][A-Za-z0-9._-]+(?:[\\/]|\b)`,
        String.raw`\\\\[A-Za-z0-9._-]+[\\/](?:Us` +
            String.raw`ers|home|profiles)[\\/][A-Za-z0-9._-]+(?:[\\/]|\b)`,
        '~/de' + 'v/Repositories',
    ]
    const secrets = [
        'gh' + '[pousr]_[A-Za-z0-9]{16,}',
        'github_' + 'pat_[A-Za-z0-9_]{40,}',
        'npm_' + '[A-Za-z0-9]{36}',
        'sk_' + 'live_',
        'sk-' + '(?:proj|svcacct)-[A-Za-z0-9_-]{20,}',
        'sk-' + 'ant-api\\d{2}-[A-Za-z0-9_-]{20,}',
        'AKIA[0-9A-Z]{12}',
    ]
    return [...paths, ...secrets]
}

/** Null when unconfigured — distinct from a configured empty list. */
export function siteTerms(rootUrl = ROOT_URL) {
    let body
    try {
        body = readFileSync(new URL(SITE_NEEDLES, rootUrl), 'utf8')
    } catch {
        return null
    }
    return body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
}

export function hasInternal(rootUrl = ROOT_URL) {
    return existsSync(new URL(INTERNAL, rootUrl))
}

function boundedPatterns(terms) {
    // Word-bounded. Unbounded substrings match ordinary English — one of these names is a
    // substring of "assembled" — and a check with false positives is one that gets widened
    // until it finds nothing at all. Escaped because the file holds names, not patterns: an
    // unescaped `.` would silently widen the match and an unescaped `+` would throw.
    return terms.map((t) => `\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
}

export function buildNeedle(terms) {
    return new RegExp([...boundedPatterns(terms), ...universalPatterns()].join('|'), 'i')
}

/** What this run can and cannot see. Both callers print it; neither may imply more. */
export function coverage(site) {
    return site === null
        ? `UNIVERSAL CLASSES ONLY — ${SITE_NEEDLES} absent, site names unscanned`
        : `universal classes + ${site.length} site terms`
}

/** 1-based line numbers of `body` that trip `needle`. */
export function scanText(body, needle) {
    const hits = []
    for (const [i, line] of body.split('\n').entries()) {
        if (needle.test(line)) hits.push(i + 1)
    }
    return hits
}

export function scanPathText(path, body, site) {
    const allowance = ALLOWED.find((item) => item.file === path)
    if (!allowance) {
        return scanText(body, buildNeedle(site))
    }
    const fullNeedle = buildNeedle(site)
    const sitePatterns = boundedPatterns(site)
    const siteNeedle = sitePatterns.length === 0 ? null : new RegExp(sitePatterns.join('|'), 'i')
    const allowedLines = new Set(allowance.lineSha256)
    const hits = []
    for (const [index, line] of body.split('\n').entries()) {
        const digest = createHash('sha256').update(line).digest('hex')
        const needle = allowedLines.has(digest) ? siteNeedle : fullNeedle
        if (needle?.test(line)) hits.push(index + 1)
    }
    return hits
}

function publicationNeedle(commitMessage = false) {
    const patterns = [
        '\\bphase[-_\\s]*\\d+',
        '\\bwave[-_\\s]*\\d+',
        '\\b(?:plan|task)[-_\\s]*\\d+(?:[-_.]\\d+)*',
        '\\b\\d{2}(?:[-_.]\\d{2}){1,2}[-_\\s]+(?:plan|task)\\b',
        '\\b(?:milestone[-_\\s]+M?\\d+|M\\d+[-_\\s]+milestone)\\b',
        '\\bREQ[-_\\s]*F\\d',
        'PHASE\\d+_',
        '\\.[a-z][a-z0-9_-]*[/\\\\](?:STATE|PLAN|REQUIREMENTS)\\.md\\b',
        '\\.(?:claude|codex)[/\\\\]worktrees(?:[/\\\\]|\\b)',
    ]
    if (commitMessage) {
        patterns.push(
            '\\b[a-z]+\\(\\d{2}-\\d{2}(?:-\\d{2})?\\)',
            // Agent tools append links to the private conversation that produced a commit.
            'claude\\.ai/code/session',
            '\\bClaude-Session:',
            'chatgpt\\.com/codex',
            // Any other link in a message points at something a public reader cannot open.
            'https?://(?!github\\.com/b0dea/cockpit(?![\\w.-]))',
        )
    }
    return new RegExp(patterns.join('|'), 'i')
}

function isNecessaryIgnoreRule(line) {
    const rule = line.trim()
    if (rule === '' || rule.startsWith('#') || rule.startsWith('!')) return false
    const relativeRule = rule.replace(/^\//, '')
    return relativeRule === '.claude/work' + 'trees/' ||
        relativeRule === '.codex/work' + 'trees/'
}

export function scanPublicationPathText(path, body) {
    const needle = publicationNeedle(path === 'commit-message')
    const pathHits = needle.test(path) ? [1] : []
    const bodyHits = []
    for (const [index, line] of body.split('\n').entries()) {
        if (path === '.gitignore' && isNecessaryIgnoreRule(line)) continue
        if (path === 'package-lock.json' && /^\s*"resolved":\s*"https:\/\/registry\.npmjs\.org\//.test(line)) continue
        if (needle.test(line)) bodyHits.push(index + 1)
    }
    return [...new Set([...pathHits, ...bodyHits])].sort((a, b) => a - b)
}

const SCISSORS = /^# -{24} >8 -{24}$/

/**
 * The part of a commit-msg hook's input that Git will keep. Git runs the hook before stripping
 * comment lines, so a verbose commit still carries its diff below the scissors line; scanning that
 * would reject any commit whose diff contains a link. Lines are blanked, not removed, so reported
 * line numbers still match the file the author edits.
 */
export function commitMessageText(raw) {
    const lines = raw.split('\n')
    const cut = lines.findIndex((line) => SCISSORS.test(line))
    return (cut < 0 ? lines : lines.slice(0, cut)).map((line) => (line.startsWith('#') ? '' : line)).join('\n')
}

/** Both classes for one commit message: credentials and private names, then development ceremony. */
export function scanCommitMessage(raw, rootUrl = ROOT_URL) {
    const site = siteTerms(rootUrl)
    if (hasInternal(rootUrl) && (site === null || site.length === 0)) {
        throw new Error(`hygiene-scan: ${SITE_NEEDLES} must be a readable, non-empty file when ${INTERNAL}/ exists`)
    }
    const body = commitMessageText(raw)
    return {
        coverage: coverage(site),
        identifying: scanPathText('commit-message', body, site ?? []),
        ceremony: scanPublicationPathText('commit-message', body),
    }
}

/** Batched object reads preserve NUL-delimited paths and avoid a subprocess per file. */
function gitContents(paths, root, objectName, label) {
    const out = execFileSync('git', ['cat-file', '--batch', '-Z'], {
        cwd: root,
        input: paths.map((path) => `${objectName(path)}\0`).join(''),
        maxBuffer: 256 * 1024 * 1024,
    })
    const bodies = new Map()
    let at = 0
    for (const path of paths) {
        const eol = out.indexOf(0x00, at)
        const header = eol < 0 ? '' : out.toString('utf8', at, eol)
        const parsed = /^\S+ \S+ (\d+)$/.exec(header)
        if (!parsed) {
            throw new Error(
                `hygiene-scan: cannot read ${label} content of ${JSON.stringify(path)}: ${header || 'no header'}`,
            )
        }
        const start = eol + 1
        const size = Number(parsed[1])
        bodies.set(path, out.toString('utf8', start, start + size))
        at = start + size + 1
    }
    return bodies
}

function nulPaths(args, root) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
}

export function trackedContents(root = ROOT) {
    const paths = nulPaths(['ls-files', '--cached', '-z'], root)
    return gitContents(paths, root, (path) => `:${path}`, 'tracked')
}

export function untrackedPaths(root = ROOT) {
    return nulPaths(['ls-files', '--others', '--exclude-standard', '-z'], root)
}

export function scanGitHistory(root = ROOT) {
    root = resolve(root)
    const site = siteTerms(pathToFileURL(`${root}${sep}`))
    const findings = []
    const gaps = []
    const deadline = Date.now() + 300_000
    const git = (args, input) => {
        try {
            return execFileSync('git', args, { cwd: root, input, maxBuffer: 128 * 1024 * 1024,
                timeout: Math.max(1, Math.min(30_000, deadline - Date.now())), stdio: ['pipe', 'pipe', 'pipe'] })
        } catch {
            throw new Error(`hygiene-scan: history Git ${args[0]} failed or exceeded its time/output bound`)
        }
    }
    const report = (commits, blobs) => ({ surface: 'reachable-git-history', coverage: coverage(site),
        commits, blobs, complete: gaps.length === 0, clean: gaps.length === 0 && findings.length === 0,
        findings, gaps })
    if (hasInternal(pathToFileURL(`${root}${sep}`)) && (site === null || site.length === 0)) {
        gaps.push('site-specific terms are required when internal material exists')
    }
    if (git(['rev-parse', '--is-shallow-repository']).toString('utf8').trim() !== 'false') {
        gaps.push('history is shallow')
        return report(0, 0)
    }
    const commits = git(['rev-list', '--all', '--reverse']).toString('utf8').trim().split('\n').filter(Boolean)
    if (commits.length === 0 || commits.length > 10_000) {
        gaps.push('reachable commit count is empty or exceeds 10000')
        return report(0, 0)
    }
    const rows = []
    const seen = new Set()
    const add = (commit, path, object, size) => {
        const key = `${object}\0${path}`
        if (seen.has(key)) return
        seen.add(key)
        if (size > HISTORY_OBJECT_BYTE_LIMIT || rows.length >= HISTORY_OBJECT_COUNT_LIMIT) {
            gaps.push(`${commit}:${JSON.stringify(path)} exceeds the history byte/object bound`)
            return
        }
        rows.push({ commit, path, object, size })
    }
    const refs = git(['for-each-ref', '--format=%(refname)%00%(objecttype)%00%(objectname)%00'])
    let refCursor = 0
    while (refCursor < refs.length) {
        const fields = []
        for (let index = 0; index < 3; index++) {
            const end = refs.indexOf(0, refCursor)
            if (end < 0) throw new Error('hygiene-scan: history ref inventory is truncated')
            fields.push(refs.subarray(refCursor, end))
            refCursor = end + 1
        }
        if (refs[refCursor++] !== 10) throw new Error('hygiene-scan: history ref inventory is malformed')
        const [, typeBytes, objectBytes] = fields
        const type = typeBytes.toString('ascii')
        const object = objectBytes.toString('ascii')
        if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(object)) throw new Error('hygiene-scan: history returned an invalid ref object')
        let name
        try { name = new TextDecoder('utf-8', { fatal: true }).decode(fields[0]) }
        catch { gaps.push('a reachable ref name is invalid UTF-8'); continue }
        if (scanPathText('(ref)', name, site ?? []).length > 0) {
            const category = name.startsWith('refs/heads/') ? 'heads' : name.startsWith('refs/tags/') ? 'tags' : 'other'
            if (findings.length < 10_000) findings.push({ commit: object, path: `(ref:${category})`, kind: 'consumer-identifier', line: 1 })
            else if (!gaps.includes('history findings exceed 10000')) gaps.push('history findings exceed 10000')
        }
        if (type === 'commit') continue
        if (type !== 'tag') { gaps.push('a reachable non-commit ref has no authenticated tree path'); continue }
        add(object, '(tag)', object, Number(git(['cat-file', '-s', object]).toString('utf8').trim()))
    }
    for (const commit of commits) {
        if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) throw new Error('hygiene-scan: history returned an invalid commit identity')
        add(commit, '(commit)', commit, Number(git(['cat-file', '-s', commit]).toString('utf8').trim()))
        const entries = git(['ls-tree', '-rz', '--long', '--full-tree', commit])
        let cursor = 0
        while (cursor < entries.length) {
            const end = entries.indexOf(0, cursor)
            const tab = entries.indexOf(9, cursor)
            if (end < 0 || tab < cursor || tab > end) throw new Error('hygiene-scan: history tree entry is truncated')
            const header = entries.toString('ascii', cursor, tab)
            const pathname = entries.subarray(tab + 1, end)
            cursor = end + 1
            let path
            try { path = new TextDecoder('utf-8', { fatal: true }).decode(pathname) }
            catch {
                gaps.push(`${commit}: invalid UTF-8 pathname (sha256 ${createHash('sha256').update(pathname).digest('hex')})`)
                continue
            }
            const match = /^\d+ (blob|commit) ([a-f0-9]+)\s+(\d+|-)$/.exec(header)
            if (!match) throw new Error('hygiene-scan: history returned an unreadable tree entry')
            const [, type, object, size] = match
            if (type !== 'blob') { gaps.push(`${commit}:${JSON.stringify(path)} is an external submodule`); continue }
            add(commit, path, object, Number(size))
        }
    }
    for (let offset = 0; offset < rows.length;) {
        let end = offset
        let batchBytes = 0
        while (end < rows.length && end - offset < HISTORY_BATCH_OBJECT_LIMIT) {
            const nextBytes = batchBytes + rows[end].size
            if (end > offset && nextBytes > HISTORY_BATCH_BYTE_LIMIT) break
            batchBytes = nextBytes
            end += 1
        }
        const batch = rows.slice(offset, end)
        const output = git(['cat-file', '--batch', '-Z'], batch.map(row => `${row.object}\0`).join(''))
        let cursor = 0
        for (const row of batch) {
            const end = output.indexOf(0, cursor)
            const header = output.toString('utf8', cursor, end)
            if (end < 0 || !new RegExp(`^${row.object} (blob|commit|tag) ${row.size}$`).test(header)) {
                throw new Error('hygiene-scan: history object bytes do not match the captured inventory')
            }
            const start = end + 1
            const body = output.subarray(start, start + row.size)
            if (body.length !== row.size || output[start + row.size] !== 0) throw new Error('hygiene-scan: history object is truncated')
            cursor = start + row.size + 1
            let text
            try {
                if (body.includes(0)) throw new Error('binary')
                text = new TextDecoder('utf-8', { fatal: true }).decode(body)
            } catch {
                gaps.push(`${row.commit}:${JSON.stringify(row.path)} is binary or invalid UTF-8`)
                continue
            }
            const found = scanPathText(row.path, text, site ?? []).map(line => ({ kind: 'consumer-identifier', line }))
            if (row.path === '(commit)' || row.path === '(tag)') {
                // Object headers precede the message; line numbers stay relative to the whole object.
                const headerEnd = text.indexOf('\n\n')
                const headerLines = headerEnd < 0 ? text.split('\n').length : text.slice(0, headerEnd + 2).split('\n').length - 1
                const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2)
                for (const line of scanPublicationPathText('commit-message', message)) {
                    found.push({ kind: 'development-ceremony', line: headerLines + line })
                }
            }
            for (const { kind, line } of found) {
                if (findings.length >= 10_000) {
                    if (!gaps.includes('history findings exceed 10000')) gaps.push('history findings exceed 10000')
                    break
                }
                findings.push({ commit: row.commit, path: row.path, kind, line })
            }
            if (scanPathText(row.path, row.path, site ?? []).length > 0) findings.push({
                commit: row.commit, path: row.path, kind: 'consumer-identifier', line: 0,
            })
        }
        if (cursor !== output.length) throw new Error('hygiene-scan: history object batch has unexpected trailing bytes')
        offset = end
    }
    return report(commits.length, rows.filter(row => row.path !== '(commit)' && row.path !== '(tag)').length)
}

function stagedContents(paths) {
    return gitContents(paths, process.cwd(), (path) => `:${path}`, 'staged')
}

/**
 * Scans what is about to enter history: the index, not the working tree. A file can be staged
 * clean and dirty on disk, and reading the tree says nothing about the first — which is the
 * only thing a commit carries. Needles come from this checkout; the index comes from cwd.
 *
 * Exit 1 means hits. Any other non-zero means the scan could not run, and the hook says so
 * rather than telling someone to anonymise a line that was never found.
 */
function scanIndex() {
    const rootUrl = pathToFileURL(`${resolve(process.cwd())}${sep}`)
    const site = siteTerms(rootUrl)
    if (hasInternal(rootUrl) && (site === null || site.length === 0)) {
        console.error(`hygiene-scan: ${SITE_NEEDLES} must be a readable, non-empty file when ${INTERNAL}/ exists`)
        process.exit(2)
    }
    if (site === null) console.error(`hygiene-scan: ${coverage(site)}`)
    const paths = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=d', '-z'], {
        encoding: 'utf8',
    })
        .split('\0')
        .filter(Boolean)
    if (paths.length === 0) return

    const hits = []
    const publicationHits = []
    let contents
    try {
        contents = stagedContents(paths)
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(2)
    }
    for (const [path, body] of contents) {
        for (const line of scanPathText(path, body, site ?? [])) hits.push(`${path}:${line}`)
        for (const line of scanPublicationPathText(path, body)) publicationHits.push(`${path}:${line}`)
    }

    if (hits.length > 0) {
        console.error(`hygiene-scan: consumer-identifying material staged (${coverage(site)}):`)
        for (const hit of hits) console.error(`  ${hit}`)
        process.exit(1)
    }
    if (publicationHits.length > 0) {
        console.error('hygiene-scan: private development ceremony staged:')
        for (const hit of publicationHits) console.error(`  ${hit}`)
        process.exit(1)
    }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const args = process.argv.slice(2)
    if (args.length === 0) scanIndex()
    else if (args[0] === '--history' && (args.length === 1 || args.length === 3 && args[1] === '--root')) {
        try {
            const result = scanGitHistory(args[2] ?? ROOT)
            process.stdout.write(`${JSON.stringify(result)}\n`)
            process.exitCode = result.clean ? 0 : result.complete ? 1 : 2
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error))
            process.exitCode = 2
        }
    } else {
        console.error('hygiene-scan: expected no arguments, or --history [--root <repository>]')
        process.exitCode = 2
    }
}
