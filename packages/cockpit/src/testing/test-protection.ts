// Detects a change that makes tests pass by weakening them. It has no imports on purpose: CI runs
// the base revision's copy of scripts/check-test-protection.mjs beside this file, so the detector
// that judges a change is never the one the change edited, and the same code judges a consumer's
// checkout when `work grade` runs.

export interface DiffFile {
    old: string
    next: string
    hunk: boolean
    removed: boolean
    removedLines: string[]
    added: string[]
    renamed: boolean
    deleted: boolean
}

export interface WeakeningFinding {
    readonly path: string
    readonly kind: WeakeningKind
    readonly reason: string
}

export type WeakeningKind = 'test-file-removed' | 'test-skipped' | 'check-suppressed' | 'tests-removed' | 'assertions-removed'
    | 'assertions-loosened' | 'assertion-vacuous' | 'test-selection-narrowed'

function gitPath(value: string): string {
    if (!value.startsWith('"')) return value
    // Git quotes paths as C strings, including octal UTF-8 bytes.
    const bytes: number[] = []
    for (let i = 1; i < value.length - 1; i++) {
        if (value[i] !== '\\') { bytes.push(...Buffer.from(value[i]!)); continue }
        const octal = /^[0-7]{1,3}/.exec(value.slice(i + 1))?.[0]
        if (octal) { bytes.push(Number.parseInt(octal, 8)); i += octal.length; continue }
        const escaped = value[++i]!
        const controls: Record<string, string> = { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"' }
        if (!(escaped in controls)) throw new Error('unsupported Git path escape')
        bytes.push(...Buffer.from(controls[escaped]!))
    }
    return Buffer.from(bytes).toString('utf8')
}

/** Reads `git diff` output (taken with --unified=0 and core.quotePath=true) into one record per file. */
export function parseDiff(diff: string): DiffFile[] {
    const files: DiffFile[] = []
    let file: DiffFile | undefined
    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git ')) {
            const names = /^diff --git ("(?:\\.|[^"])*"|a\/\S+) ("(?:\\.|[^"])*"|b\/\S+)$/.exec(line)
            file = { old: names ? gitPath(names[1]!).slice(2) : '', next: names ? gitPath(names[2]!).slice(2) : '', hunk: false, removed: false, removedLines: [], renamed: false, deleted: false, added: [] }
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
    return files
}

/**
 * Why added lines turn off or short-circuit what runs. Only explicit added-line forms are measured;
 * this is not JavaScript dataflow analysis.
 */
export function additiveBypassReasons(added: readonly string[]): string[] {
    const reasons: string[] = []
    if (/(?:\.\s*|\[\s*['"])(?:skip|todo|only|skipIf|runIf|fails)\b|\b(?:skip|todo|only)\s*:\s*true/.test(added.join('\n'))) {
        reasons.push('test selection or expected-failure semantics added')
    }
    if (added.some(line => /^[ \t]*return[ \t]*;?[ \t]*(?:\/\/.*)?$/.test(line))) {
        reasons.push('potential additive control-flow bypass: bare return added')
    }
    if (added.some(line => /^[ \t]*(?:if\s*\(\s*(?:true|1)\s*\)\s*(?:\{\s*)?return\s*;?(?:\s*\})?\s*(?:\/\/.*)?$|if\s*\(\s*(?:false|0|null|undefined)\s*\)\s*\{|(?:false\s*&&|true\s*\|\|)\s*(?:describe|test|it|suite)\s*\(|process\s*\.\s*exit\s*\(\s*(?:0\s*)?\))/.test(line))) {
        reasons.push('potential additive control-flow bypass: explicit static bypass added')
    }
    return reasons
}

// JS/TS first, then the Python forms that mean the same. A match in an added comment still counts:
// a directive is a comment.
const SKIPPED = /\b(?:it|test|describe|suite|context|bench)\s*\.\s*(?:skip|only|todo|skipIf|runIf|fails|failing|fixme)\b|\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(|\b(?:skip|only)\s*:\s*true|\bpytest\s*\.\s*(?:mark\s*\.\s*(?:skip|skipif|xfail)|skip)\b|\bunittest\s*\.\s*(?:skip|skipIf|skipUnless|expectedFailure)\b|^\s*@(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\s*\.\s*skipTest\s*\(/
const SUPPRESSED = /@ts-ignore|@ts-nocheck|eslint-disable|\bnoqa\b|\btype:\s*ignore\b|\bpylint:\s*disable\b/
const TEST_DECLARATION = /^\s*(?:(?:it|test)\s*(?:\.\s*\w+)*\s*(?:\.\s*each\s*\([^)]*\))?\s*\(|def\s+test_|async\s+def\s+test_)/
const ASSERTION = /\bexpect\s*\(|\bassert\b|\bassert[A-Z]\w*\s*\(|\.should\b|\bt\.(?:is|true|deepEqual|equal|throws)\s*\(/
const STRONG = /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveBeenCalledWith|toHaveLength|toThrow\w*|toContain\w*|toMatch)\s*\(|\bassert(?:Equal|Equals|In|Raises|IsNone)\b|\bassert\s+\S+\s*(?:==|!=|in)\s/
const WEAK = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined)\s*\(|\bexpect\.(?:anything|any)\s*\(|\.not\.toBeNull\s*\(|\bassert\s+\w+\s*$|\bassertTrue\s*\(\s*\w+\s*\)/
const VACUOUS = /\bexpect\s*\(\s*(?:true|1|false|0|null|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(|\bassert\s+(?:True|1|not\s+False)\s*$|\bassert\s*\(?\s*true\s*\)?\s*;?\s*$|\bassertTrue\s*\(\s*True\s*\)/
// What a test runner's own configuration says about which files it runs.
const NARROWING = /\b(?:exclude|testPathIgnorePatterns|testIgnore|ignore|deselect|norecursedirs|skip)\b|--ignore\b|--deselect\b|--exclude\b|--passWithNoTests|\|\|\s*true\b|\bexit\s+0\b/
const WIDENING = /\b(?:include|testMatch|testRegex|testpaths|projects)\b/
const TEST_SCRIPT = /^\s*"(?:pre|post)?test[^"]*"\s*:/

const count = (lines: readonly string[], pattern: RegExp) => lines.filter(line => pattern.test(line)).length

export interface TestRoles {
    readonly isTest: (path: string) => boolean
    /** A runner's configuration, or a manifest that carries a test script. */
    readonly isTestConfig: (path: string) => boolean
}

/**
 * The findings a diff earns over the files `roles` calls tests. A diff cannot prove that a
 * replacement keeps its force, so a removal is flagged and a person acknowledges the legitimate ones.
 */
export function classifyTestWeakening(files: readonly DiffFile[], roles: TestRoles): WeakeningFinding[] {
    const findings: WeakeningFinding[] = []
    for (const file of files) {
        const path = file.deleted || file.next === '/dev/null' ? file.old : file.next
        const finding = (kind: WeakeningKind, reason: string) => findings.push({ path, kind, reason })
        const wasTest = roles.isTest(file.old)
        if (wasTest && (file.deleted || file.next === '/dev/null' || file.renamed && !roles.isTest(file.next))) {
            finding('test-file-removed', 'a test file was deleted or moved out of the tests')
            continue
        }
        if (roles.isTest(path)) {
            if (count(file.added, SKIPPED)) finding('test-skipped', 'a test was skipped, focused, marked todo or expected to fail')
            if (count(file.added, SUPPRESSED)) finding('check-suppressed', 'a type or lint check was suppressed in a test')
            if (count(file.removedLines, TEST_DECLARATION) > count(file.added, TEST_DECLARATION)) finding('tests-removed', 'more tests were removed than added')
            if (count(file.removedLines, ASSERTION) > count(file.added, ASSERTION)) finding('assertions-removed', 'more assertions were removed than added')
            else if (count(file.removedLines, STRONG) > count(file.added, STRONG) && count(file.added, WEAK) > count(file.removedLines, WEAK)) {
                finding('assertions-loosened', 'specific assertions were replaced by weaker ones')
            }
            if (count(file.added, VACUOUS)) finding('assertion-vacuous', 'an assertion that cannot fail was added')
        } else if (roles.isTestConfig(path)) {
            const manifest = /(?:^|\/)package\.json$/.test(path)
            const scriptsAdded = manifest ? file.added.filter(line => TEST_SCRIPT.test(line)) : file.added
            if (count(scriptsAdded, NARROWING)) finding('test-selection-narrowed', 'test configuration now excludes, ignores or tolerates the absence of tests')
            else if (manifest ? count(file.removedLines, TEST_SCRIPT) > count(scriptsAdded, TEST_SCRIPT)
                : count(file.removedLines, WIDENING) > count(file.added, WIDENING)) finding('test-selection-narrowed', 'test configuration no longer selects what it selected')
        }
    }
    return findings
}
