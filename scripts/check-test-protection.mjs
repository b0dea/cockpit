import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { additiveBypassReasons, parseDiff } from '../packages/cockpit/src/testing/test-protection.ts'

const ACK = 'COCKPIT_TEST_WEAKENING_ACK'
const protectedPaths = new Set([
    'scripts/check-test-protection.mjs',
    'scripts/check-test-protection.d.mts',
    'packages/cockpit/src/testing/test-protection.ts',
    '.github/workflows/ci.yml',
    // What decides which tests run and how their results are judged.
    'vitest.config.ts',
    'scripts/run-changed-tests.mjs',
    'scripts/skip-allowlist-reporter.mjs',
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

/** Conservatively flag removals: a diff cannot prove that a replacement keeps its force. */
export function classifyTestProtection(diff, commitMessages = '') {
    const findings = []
    const files = parseDiff(diff)
    for (const item of files) {
        const path = protectedPath(item.old) ? item.old : item.next
        if (!protectedPath(path)) continue
        if (item.deleted || item.next === '/dev/null') findings.push({ path, reason: 'protected control file deleted' })
        else if (item.renamed) findings.push({ path, reason: 'protected control file renamed' })
        else if (item.removed && (path !== 'package.json' || item.removedLines.length === 0
            || item.removedLines.some(line => MANIFEST_CONTROL_LINE.test(line)))) findings.push({ path, reason: 'protected control lines removed or replaced' })
        for (const reason of additiveBypassReasons(item.added)) findings.push({ path, reason })
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
