import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const mechanism = {
    id: 'test-protection', module: 'scripts/check-test-protection.mjs',
    exports: ['classifyTestProtection', 'runTestProtectionCli'],
}

const ACK = 'COCKPIT_TEST_WEAKENING_ACK'
const protectedPaths = new Set([
    'scripts/check-test-protection.mjs',
    'scripts/check-test-protection.d.mts',
    '.github/workflows/ci.yml',
    // What decides which tests run and how their results are judged.
    'vitest.config.ts',
    'scripts/run-tests.mjs',
    'scripts/run-changed-tests.mjs',
    'scripts/immediate-failure-reporter.mjs',
    'package.json',
])

// The root manifest also carries dependency and metadata edits that say nothing about testing, so
// only a removed or replaced script that runs tests, checks or the build counts there. A change
// to `test` always removes its old line, which is why removal is what is measured.
const MANIFEST_CONTROL_LINE = /^\s*"(?:pre|post)?(?:test|lint|typecheck|build)[^"]*"\s*:/

function protectedPath(path) {
    return protectedPaths.has(path) || path.startsWith('packages/cockpit/src/guards/fixtures/')
        || path.startsWith('packages/cockpit/src/test-support/') || path.startsWith('packages/cockpit/test-support/')
        || /^packages\/cockpit\/src\/.*\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)
}

function gitPath(value) {
    if (!value.startsWith('"')) return value
    // Git quotes paths as C strings, including octal UTF-8 bytes.
    const bytes = []
    for (let i = 1; i < value.length - 1; i++) {
        if (value[i] !== '\\') { bytes.push(...Buffer.from(value[i])); continue }
        const octal = /^[0-7]{1,3}/.exec(value.slice(i + 1))?.[0]
        if (octal) { bytes.push(Number.parseInt(octal, 8)); i += octal.length; continue }
        const escaped = value[++i]
        const controls = { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"' }
        if (!(escaped in controls)) throw new Error('unsupported Git path escape')
        bytes.push(...Buffer.from(controls[escaped]))
    }
    return Buffer.from(bytes).toString('utf8')
}

/** Conservatively flag removals: a diff cannot prove that a replacement keeps its force. */
export function classifyTestProtection(diff, commitMessages = '') {
    const findings = []
    let file
    const files = []
    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git ')) {
            const names = /^diff --git ("(?:\\.|[^"])*"|a\/\S+) ("(?:\\.|[^"])*"|b\/\S+)$/.exec(line)
            file = { old: names ? gitPath(names[1]).slice(2) : '', next: names ? gitPath(names[2]).slice(2) : '', hunk: false, removed: false, removedLines: [], renamed: false, deleted: false, added: [] }
            files.push(file)
        } else if (file) {
            if (line.startsWith('@@ ')) file.hunk = true
            else if (!file.hunk && line.startsWith('--- ')) file.old = gitPath(line.slice(4)).replace(/^a\//, '')
            else if (!file.hunk && line.startsWith('+++ ')) file.next = gitPath(line.slice(4)).replace(/^b\//, '')
            else if (line.startsWith('rename from ')) { file.old = gitPath(line.slice(12)); file.renamed = true }
            else if (line.startsWith('rename to ')) file.next = gitPath(line.slice(10))
            else if (line.startsWith('deleted file mode ')) file.deleted = true
            else if (line.startsWith('-') && line.slice(1).trim()) { file.removed = true; file.removedLines.push(line.slice(1)) }
            else if (line.startsWith('+')) file.added.push(line.slice(1))
            else if (line.startsWith('Binary files ')) file.removed = true
        }
    }
    for (const item of files) {
        const path = protectedPath(item.old) ? item.old : item.next
        if (!protectedPath(path)) continue
        if (item.deleted || item.next === '/dev/null') findings.push({ path, reason: 'protected control file deleted' })
        else if (item.renamed) findings.push({ path, reason: 'protected control file renamed' })
        else if (item.removed && (path !== 'package.json' || item.removedLines.length === 0
            || item.removedLines.some(line => MANIFEST_CONTROL_LINE.test(line)))) findings.push({ path, reason: 'protected control lines removed or replaced' })
        const added = item.added.join('\n')
        if (/(?:\.\s*|\[\s*['"])(?:skip|todo|only|skipIf|runIf|fails)\b|\b(?:skip|todo|only)\s*:\s*true/.test(added)) {
            findings.push({ path, reason: 'test selection or expected-failure semantics added' })
        }
        if (item.added.some(line => /^[ \t]*return[ \t]*;?[ \t]*(?:\/\/.*)?$/.test(line))) {
            findings.push({ path, reason: 'potential additive control-flow bypass: bare return added' })
        }
        // Only explicit added-line forms are measured; this is not JavaScript dataflow analysis.
        if (item.added.some(line => /^[ \t]*(?:if\s*\(\s*(?:true|1)\s*\)\s*(?:\{\s*)?return\s*;?(?:\s*\})?\s*(?:\/\/.*)?$|if\s*\(\s*(?:false|0|null|undefined)\s*\)\s*\{|(?:false\s*&&|true\s*\|\|)\s*(?:describe|test|it|suite)\s*\(|process\s*\.\s*exit\s*\(\s*(?:0\s*)?\))/.test(line))) {
            findings.push({ path, reason: 'potential additive control-flow bypass: explicit static bypass added' })
        }
    }
    const acknowledged = new RegExp(`(^|[^A-Za-z0-9_])${ACK}($|[^A-Za-z0-9_])`).test(commitMessages)
    return { findings, acknowledged, allowed: findings.length === 0 || acknowledged }
}

export function runTestProtectionCli(argv) {
    try {
        if (argv.length !== 3) throw new Error('expected base, head and merge-base|exact')
        const [base, head, mode] = argv
        const validId = value => /^[a-f0-9]{40}$/.test(value) && value !== '0'.repeat(40)
        const initial = base === '0'.repeat(40) && mode === 'exact'
        if ((!validId(base) && !initial) || !validId(head)) throw new Error('base and head must be nonzero lowercase 40-character object IDs')
        if (mode !== 'merge-base' && mode !== 'exact') throw new Error('range mode must be merge-base or exact')
        const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        if (initial) {
            if (git(['cat-file', '-t', head]).trim() !== 'commit'
                || git(['rev-list', '--parents', '-n', '1', head]).trim() !== head) {
                throw new Error('an initial baseline must be one authenticated root commit')
            }
            console.log(`test protection initial root baseline ${head}: no preceding controls to compare`)
            return 0
        }
        for (const id of [base, head]) {
            if (git(['cat-file', '-t', id]).trim() !== 'commit') throw new Error(`${id} is not a commit`)
        }
        const start = mode === 'merge-base' ? git(['merge-base', base, head]).trim() : base
        if (!validId(start) || git(['cat-file', '-t', start]).trim() !== 'commit') throw new Error('merge-base is not one authenticated commit')
        const range = `${start}..${head}`
        const diff = git(['-c', 'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--text', '--find-renames', '--unified=0', start, head, '--'])
        const messages = git(['log', '--format=%B%x00', range, '--'])
        const result = classifyTestProtection(diff, messages)
        console.log(`test protection ${range} (${mode})`)
        for (const finding of result.findings) console.log(`${finding.path}: ${finding.reason}`)
        if (result.findings.length) {
            console.log(result.acknowledged ? `weakening acknowledged by ${ACK} in checked commit messages` : `weakening requires ${ACK} in checked commit messages`)
        } else console.log('no protected control weakening found')
        return result.allowed ? 0 : 1
    } catch (error) {
        console.error(`TEST_PROTECTION_RANGE_INVALID: ${error instanceof Error ? error.message : String(error)}`)
        return 2
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    process.exitCode = runTestProtectionCli(process.argv.slice(2))
}
