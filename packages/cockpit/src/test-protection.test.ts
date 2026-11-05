import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyTestProtection } from '../../../scripts/check-test-protection.mjs'
import { parseDiff } from './testing/test-protection.js'
import { testFilePatterns, weakeningFindings } from './testing/weakening.js'

const SCRIPT = fileURLToPath(new URL('../../../scripts/check-test-protection.mjs', import.meta.url))
const GUARD = 'packages/cockpit/src/guards/evaluator.test.ts'
const ACK = 'COCKPIT_TEST_WEAKENING_ACK'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function patch(path: string, removed: string, added = ''): string {
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${removed}\n${added ? `+${added}\n` : ''}`
}

// Build a synthetic object database directly: the production CLI only reads Git, and no
// fixture command changes the shared checkout, index, refs, or stash.
function repository() {
    const root = mkdtempSync(join(tmpdir(), 'test-protection-'))
    roots.push(root)
    mkdirSync(join(root, '.git/objects'), { recursive: true })
    mkdirSync(join(root, '.git/refs'), { recursive: true })
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/synthetic\n')
    writeFileSync(join(root, '.git/config'), '[core]\nrepositoryformatversion = 0\nbare = false\n')
    function object(kind: string, value: Buffer | string): string {
        const bytes = Buffer.from(value)
        const raw = Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes])
        const oid = createHash('sha1').update(raw).digest('hex')
        const path = join(root, '.git/objects', oid.slice(0, 2), oid.slice(2))
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, deflateSync(raw))
        return oid
    }
    function tree(files: Record<string, string>): string {
        const entries = new Map<string, Record<string, string>>()
        const leaves = new Map<string, string>()
        for (const [path, value] of Object.entries(files)) {
            const slash = path.indexOf('/')
            if (slash < 0) leaves.set(path, object('blob', value))
            else {
                const name = path.slice(0, slash)
                const nested = entries.get(name) ?? {}
                nested[path.slice(slash + 1)] = value
                entries.set(name, nested)
            }
        }
        const records = [
            ...[...leaves].map(([name, oid]) => ({ name, mode: '100644', oid })),
            ...[...entries].map(([name, nested]) => ({ name, mode: '40000', oid: tree(nested) })),
        ].sort((a, b) => (a.name + (a.mode === '40000' ? '/' : '')).localeCompare(b.name + (b.mode === '40000' ? '/' : ''), 'en'))
        return object('tree', Buffer.concat(records.map(({ name, mode, oid }) =>
            Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]))))
    }
    function commit(files: Record<string, string>, parent?: string, message = 'synthetic change'): string {
        return object('commit', `tree ${tree(files)}\n${parent ? `parent ${parent}\n` : ''}author Synthetic <synthetic@example.invalid> 1700000000 +0000\ncommitter Synthetic <synthetic@example.invalid> 1700000000 +0000\n\n${message}\n`)
    }
    function cli(base: string, head: string, mode: string, env: NodeJS.ProcessEnv = {}) {
        return spawnSync(process.execPath, [SCRIPT, base, head, mode], {
            cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
        })
    }
    return { root, commit, cli }
}

describe('test protection diff classifier', () => {
    it.each([
        GUARD,
        'packages/cockpit/src/surfaces/restrictions.test.ts',
        'packages/cockpit/src/guards/invocation-parser.test.ts',
        'packages/cockpit/src/guards/harness-adapter.test.ts',
        'packages/cockpit/src/guards/host.test.ts',
        'packages/cockpit/src/environment/application.test.ts',
        'packages/cockpit/src/generated-environment/command.test.ts',
        'packages/cockpit/src/cli.test.ts',
        'packages/cockpit/src/invocation.test.ts',
        'packages/cockpit/src/schema.test.ts',
        'packages/cockpit/src/packaging.test.ts',
        'packages/cockpit/src/architecture.test.ts',
        'packages/cockpit/src/test-protection.test.ts',
        'packages/cockpit/src/guards/fixtures/invocation-corpus.ts',
    ])('retains removed or replaced controls in %s regardless of writing tool', (path) => {
        const result = classifyTestProtection(patch(path, 'expect(result).toBe(false)', 'expect(result).toBe(true)'))
        expect(result.allowed).toBe(false)
        expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ path })]))
    })

    it.each([
        "it('denies vendor access', () => {",
        'const argv = Array(257).fill("x")',
        'expect(timeout).toBe(5000)',
        'const fixture = { decision: "deny" }',
    ])('conservatively retains titles, fixture coverage and bounds: %s', (line) => {
        expect(classifyTestProtection(patch(GUARD, line)).allowed).toBe(false)
    })

    it.each(['it.skip(', 'test.todo(', 'describe.only(', 'it["skip"](', 'test?.skip(', 'it.skipIf(true)(', 'describe.runIf(false)('])('rejects added selection semantics: %s', (line) => {
        expect(classifyTestProtection(patch(GUARD, '', line)).allowed).toBe(false)
    })

    it.each([
        [GUARD, '', 'expect(result).toBe(false)'],
        [GUARD, '', 'return result'],
        [GUARD, '', '  return result'],
        [GUARD, '', '  return result; // helper value'],
        [GUARD, '', '  returnValue()'],
        [GUARD, '', '  // return;'],
        [GUARD, '', '  /* return; */'],
        [GUARD, '', "  const text = 'return;'"],
        [GUARD, '', '  const text = "return"'],
        [GUARD, '', '  const text = `return;`'],
        [GUARD, '', '// if (true) return;'],
        [GUARD, '', '/* process.exit(0) */'],
        [GUARD, '', 'const text = "if (false) {"'],
        [GUARD, '', 'const text = "process.exit()"'],
        ['packages/cockpit/src/guards/evaluator.ts', 'return false', 'return true'],
        ['packages/cockpit/src/production.ts', '', 'process.exit(0)'],
    ])('permits additive expectations, helper returns, commented or quoted bypass forms and product edits: %s %j -> %j', (path, removed, added) => {
        expect(classifyTestProtection(patch(path, removed, added))).toEqual({ allowed: true, acknowledged: false, findings: [] })
    })

    it.each(['return', 'return;', '    return;', '\treturn // stop here', '  return; // stop here'])('refuses a potential additive control-flow bypass: %s', (line) => {
        const diff = patch(GUARD, '', line)
        const refused = classifyTestProtection(diff)
        expect(refused).toEqual({
            allowed: false, acknowledged: false,
            findings: [{ path: GUARD, reason: 'potential additive control-flow bypass: bare return added' }],
        })
        const accepted = classifyTestProtection(diff, ACK)
        expect(accepted.allowed).toBe(true)
        expect(accepted.acknowledged).toBe(true)
        expect(accepted.findings).toEqual(refused.findings)
    })

    it.each([
        'if (true) return;', 'if(1){ return; }',
        'if (false) {', 'if (0) {', 'if (null) {', 'if (undefined) {',
        "false && describe('denial', () => {", "false && test('denial', () => {",
        "false && it('denial', () => {", "false && suite('denial', () => {",
        "true || describe('denial', () => {", "true || test('denial', () => {",
        "true || it('denial', () => {", "true || suite('denial', () => {",
        'process.exit(0)', 'process.exit()',
    ])('refuses explicit additive control-flow bypass forms: %s', line => {
        const diff = patch('packages/cockpit/src/environment/operator-application.test.ts', '', line)
        const refused = classifyTestProtection(diff)
        expect(refused.allowed).toBe(false)
        expect(refused.findings).toContainEqual({ path: 'packages/cockpit/src/environment/operator-application.test.ts',
            reason: expect.stringContaining('potential additive control-flow bypass') })
        const accepted = classifyTestProtection(diff, ACK)
        expect(accepted).toEqual({ ...refused, allowed: true, acknowledged: true })
    })

    it.each([
        'packages/cockpit/src/harness-support.test.ts',
        'packages/cockpit/src/guards/evaluator.test.ts',
        ...['js', 'jsx', 'ts', 'tsx', 'cjs', 'mjs', 'cts', 'mts'].map(extension => `packages/cockpit/src/future/control.spec.${extension}`),
        'vitest.config.ts', 'scripts/run-changed-tests.mjs', 'scripts/skip-allowlist-reporter.mjs',
        'packages/cockpit/src/test-support/git-isolation.ts', 'packages/cockpit/test-support/application-fixture.ts',
    ])('protects every cockpit test or spec path and the files that decide what runs: %s', path => {
        expect(classifyTestProtection(patch(path, 'expect(result).toBe(false)')).allowed).toBe(false)
    })

    it('guards the root manifest test scripts but not dependency or metadata edits', () => {
        for (const line of ['    "test": "vitest run",', '    "test:changed": "node scripts/run-changed-tests.mjs",',
            '    "typecheck": "tsc",', '    "pretest": "npm run build",']) {
            expect(classifyTestProtection(patch('package.json', line, line.replace('run-', 'skip-'))).allowed).toBe(false)
        }
        for (const line of ['    "vitest": "^5.0.4",', '  "description": "before",']) {
            expect(classifyTestProtection(patch('package.json', line, line.replace('5.0.4', '5.0.5'))).allowed).toBe(true)
        }
        expect(classifyTestProtection(`diff --git a/package.json b/package.json\ndeleted file mode 100644\n`).allowed).toBe(false)
    })

    it('detects deletion, pure rename and quoted Git paths', () => {
        for (const diff of [
            `diff --git a/${GUARD} b/${GUARD}\ndeleted file mode 100644\n`,
            `diff --git a/${GUARD} b/elsewhere.ts\nsimilarity index 100%\nrename from ${GUARD}\nrename to elsewhere.ts\n`,
            `diff --git "a/${GUARD}" "b/elsewhere.ts"\nrename from ${GUARD}\nrename to elsewhere.ts\n`,
        ]) expect(classifyTestProtection(diff).allowed).toBe(false)
    })

    it('cannot hide removal by inserting diff metadata inside a changed line', () => {
        const diff = `diff --git a/${GUARD} b/${GUARD}\n--- a/${GUARD}\n+++ b/${GUARD}\n@@ -1,2 +1 @@\n--- a/product.ts\n+++ b/product.ts\n-expect(result).toBe(false)\n`
        expect(classifyTestProtection(diff).allowed).toBe(false)
    })

    it('accepts only the exact commit-message token while retaining the finding', () => {
        const diff = patch(GUARD, `expect('${ACK}').toBe('deny')`)
        const refused = classifyTestProtection(diff)
        expect(refused.allowed).toBe(false)
        expect(refused.acknowledged).toBe(false)
        for (const message of [`x${ACK}`, `${ACK}_EXTRA`, ACK.toLowerCase()]) {
            expect(classifyTestProtection(diff, message).allowed).toBe(false)
        }
        const accepted = classifyTestProtection(diff, `Reviewed exception\n\n${ACK}\n`)
        expect(accepted.allowed).toBe(true)
        expect(accepted.acknowledged).toBe(true)
        expect(accepted.findings).toEqual(refused.findings)
    })
})

describe('test protection authenticated Git CLI', () => {
    it('establishes an initial root baseline but never accepts a missing predecessor for later commits', () => {
        const repo = repository()
        const root = repo.commit({ [GUARD]: 'expect(result).toBe(false)\n' })
        const later = repo.commit({}, root)
        const initial = repo.cli('0'.repeat(40), root, 'exact')
        expect(initial.status, initial.stderr).toBe(0)
        expect(initial.stdout).toContain('initial root baseline')
        expect(repo.cli('0'.repeat(40), later, 'exact').status).toBe(2)
        expect(repo.cli('0'.repeat(40), root, 'merge-base').status).toBe(2)
        expect(repo.cli(root, '0'.repeat(40), 'exact').status).toBe(2)
    })

    it('refuses an additive bare return before a retained assertion in an actual zero-context Git diff unless its commit message acknowledges it', () => {
        const repo = repository()
        const body = `it('retains denial', () => {\n  // ${ACK}\n  expect(result).toBe(false)\n})\n`
        const changed = body.replace('  expect(', '  return;\n  expect(')
        const base = repo.commit({ [GUARD]: body })
        const head = repo.commit({ [GUARD]: changed }, base, `${ACK}_EXTRA`)
        const diff = (id: string) => execFileSync('git', ['diff', '--unified=0', base, id, '--', GUARD], { cwd: repo.root, encoding: 'utf8' })
        const actualDiff = diff(head)
        expect(actualDiff).toContain('\n+  return;\n')
        expect(actualDiff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'))).toEqual([])
        const refused = repo.cli(base, head, 'exact', { [ACK]: ACK })
        expect(refused.status).toBe(1)
        expect(refused.stdout).toContain(`${GUARD}: potential additive control-flow bypass: bare return added`)
        expect(refused.stdout).toContain(`weakening requires ${ACK} in checked commit messages`)
        const acknowledged = repo.commit({ [GUARD]: changed }, base, `Reviewed exception\n\n${ACK}\n`)
        expect(diff(acknowledged)).toBe(actualDiff)
        const accepted = repo.cli(base, acknowledged, 'exact')
        expect(accepted.status).toBe(0)
        expect(accepted.stdout).toContain(`${GUARD}: potential additive control-flow bypass: bare return added`)
        expect(accepted.stdout).toContain(`weakening acknowledged by ${ACK} in checked commit messages`)
    })

    it('refuses an actual retained-assertion wrapper and allows the identical acknowledged Git diff visibly', () => {
        const repo = repository()
        const path = 'packages/cockpit/src/guards/evaluator.test.ts'
        const body = `it('retains denial', () => {\n  expect(result).toBe(false)\n})\n`
        const changed = body.replace('  expect(', '  if (false) {\n  expect(').replace('\n})', '\n  }\n})')
        const base = repo.commit({ [path]: body })
        const head = repo.commit({ [path]: changed }, base)
        const diff = (id: string) => execFileSync('git', ['diff', '--unified=0', base, id, '--', path], { cwd: repo.root, encoding: 'utf8' })
        const actual = diff(head)
        expect(actual).toContain('\n+  if (false) {\n')
        expect(actual.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'))).toEqual([])
        const refused = repo.cli(base, head, 'exact', { [ACK]: ACK })
        expect(refused.status).toBe(1)
        expect(refused.stdout).toContain(`${path}: potential additive control-flow bypass`)
        expect(refused.stdout).toContain(`weakening requires ${ACK}`)
        const acknowledged = repo.commit({ [path]: changed }, base, ACK)
        expect(diff(acknowledged)).toBe(actual)
        const accepted = repo.cli(base, acknowledged, 'exact')
        expect(accepted.status).toBe(0)
        expect(accepted.stdout).toContain(`${path}: potential additive control-flow bypass`)
        expect(accepted.stdout).toContain(`weakening acknowledged by ${ACK}`)
    })

    it('uses actual zero-context Git diffs and keeps acknowledged weakening visible', () => {
        const repo = repository()
        const base = repo.commit({ [GUARD]: 'expect(result).toBe(false)\n' })
        const head = repo.commit({ [GUARD]: 'expect(result).toBe(true)\n' }, base)
        const refused = repo.cli(base, head, 'exact', { [ACK]: ACK })
        expect(refused.status).toBe(1)
        expect(refused.stdout + refused.stderr).toContain(ACK)
        const acknowledged = repo.commit({ [GUARD]: 'expect(result).toBe(true)\n' }, base, ACK)
        const result = repo.cli(base, acknowledged, 'exact')
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('acknowledged')
        expect(result.stdout).toContain(GUARD)
        expect(result.stdout).toContain('removed')
    })

    it('resolves merge-base for a diverged pull request and exact endpoints for pushes', () => {
        const repo = repository()
        const common = repo.commit({ [GUARD]: 'expect(result).toBe(false)\n' }, undefined, ACK)
        const base = repo.commit({ [GUARD]: 'expect(result).toBe(true)\n' }, common)
        const head = repo.commit({ [GUARD]: 'expect(result).toBe(false)\n', 'product.ts': 'export const value = true\n' }, common)
        const pr = repo.cli(base, head, 'merge-base')
        expect(pr.status).toBe(0)
        expect(pr.stdout).toContain(common)
        const push = repo.cli(base, head, 'exact')
        expect(push.status).toBe(1)
        expect(push.stdout + push.stderr).toContain(base)
        expect(push.stdout + push.stderr).toContain(ACK)
    })

    it('detects real rename and deletion and refuses a token present only in source', () => {
        const repo = repository()
        const body = `// ${ACK}\nexpect(result).toBe(false)\n`
        const base = repo.commit({ [GUARD]: body })
        const renamed = repo.commit({ 'moved.ts': body }, base)
        const deleted = repo.commit({}, base)
        for (const head of [renamed, deleted]) {
            const result = repo.cli(base, head, 'exact')
            expect(result.status).toBe(1)
            expect(result.stdout + result.stderr).toContain(GUARD)
        }
    })

    it('fails closed on malformed IDs, missing commits, invalid modes and noncommit objects', () => {
        const repo = repository()
        const base = repo.commit({ [GUARD]: 'expect(result).toBe(false)\n' })
        const tree = execFileSync('git', ['show', '-s', '--format=%T', base], { cwd: repo.root, encoding: 'utf8' }).trim()
        for (const invalid of ['HEAD', '-x', base.toUpperCase(), 'a'.repeat(40), tree]) {
            const result = repo.cli(invalid, base, 'exact')
            expect(result.status).toBe(2)
            expect(result.stderr).toContain('TEST_PROTECTION_RANGE_INVALID')
        }
        expect(repo.cli(base, base, 'other').status).toBe(2)
        expect(repo.cli(base, base, 'exact').status).toBe(0)
    })

    it('fails closed when no authenticated merge-base exists', () => {
        const repo = repository()
        const base = repo.commit({ 'a.ts': 'one' })
        const head = repo.commit({ 'b.ts': 'two' })
        const result = repo.cli(base, head, 'merge-base')
        expect(result.status).toBe(2)
        expect(result.stderr).toContain('TEST_PROTECTION_RANGE_INVALID')
    })
})

// A guard run from the change it judges can be loosened by that same change, so CI runs the base
// revision's copy. These execute the workflow's own step text against a synthetic repository.
describe('CI runs the base revision of its change guards', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)), 'utf8')
    const stepAfter = (marker: string) => {
        const from = workflow.indexOf(marker)
        const run = /\n {8}run: \|\n(?<body>(?: {10}.*\n)+)/.exec(workflow.slice(from))?.groups?.body
        if (from < 0 || !run) throw new Error(`no run step after ${marker}`)
        return run
    }
    const marker = (name: string) => `console.log('${name}')\n`

    it.each([
        ['test protection push step', 'BEFORE_SHA: ${{ github.event.before }}', 'scripts/check-test-protection.mjs', 'BEFORE_SHA', 'AFTER_SHA'],
        ['test protection pull request step', 'BASE_SHA: ${{ github.event.pull_request.base.sha }}', 'scripts/check-test-protection.mjs', 'BASE_SHA', 'HEAD_SHA'],
    ])('%s executes the base copy and refuses when the base has none', (_name, anchor, script, baseVar, headVar) => {
        const repo = repository()
        const base = repo.commit({ [script]: marker('base copy') })
        const head = repo.commit({ [script]: marker('head copy') }, base)
        const temp = mkdtempSync(join(tmpdir(), 'test-protection-temp-'))
        roots.push(temp)
        const run = (baseSha: string) => spawnSync('bash', ['-c', stepAfter(anchor)], {
            cwd: repo.root, encoding: 'utf8',
            env: { ...process.env, RUNNER_TEMP: temp, [baseVar]: baseSha, [headVar]: head },
        })

        const trusted = run(base)
        expect(trusted.stdout).toContain('base copy')
        expect(trusted.stdout).not.toContain('head copy')

        const missing = run('0'.repeat(40))
        expect(missing.status).toBe(1)
        expect(missing.stdout).toContain(`Cannot read ${script} at the base revision`)
        expect(missing.stdout).not.toContain('head copy')
    })

    // The script imports the shared detector, so the base's detector must travel with it.
    it('runs the base copy of the guard together with the base copy of the detector it imports', () => {
        const script = 'scripts/check-test-protection.mjs', core = 'packages/cockpit/src/testing/test-protection.ts'
        const repo = repository()
        const base = repo.commit({ [script]: "import { origin } from '../packages/cockpit/src/testing/test-protection.ts'\nconsole.log(origin)\n", [core]: "export const origin = 'base detector'\n" })
        const head = repo.commit({ [script]: marker('head copy'), [core]: "export const origin = 'head detector'\n" }, base)
        const temp = mkdtempSync(join(tmpdir(), 'test-protection-temp-'))
        roots.push(temp)
        const ran = spawnSync('bash', ['-c', stepAfter('BASE_SHA: ${{ github.event.pull_request.base.sha }}')], {
            cwd: repo.root, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: temp, BASE_SHA: base, HEAD_SHA: head } })
        expect(ran.stdout).toContain('base detector')
        expect(ran.stdout).not.toContain('head')
    })

    it('version pull request scope runs the base parent copy of its guard', () => {
        const step = workflow.slice(workflow.indexOf('Like the test-protection job'), workflow.indexOf('# Needs a public repository'))
        expect(step).toContain('git show HEAD^1:.github/scripts/check-version-pr-scope.sh')
        expect(step).toContain('bash "$RUNNER_TEMP/check-version-pr-scope.sh" HEAD^1 HEAD')
        expect(workflow).not.toMatch(/bash \.github\/scripts\/check-version-pr-scope\.sh|node scripts\/check-test-protection\.mjs/)
    })
})

// The release workflow publishes beside CI, so only a pull request's required check can stop it.
// macOS and the other Node lines run only when this step selects them.
describe('CI selects every platform for what can publish', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)), 'utf8')
    const from = workflow.indexOf('HEAD_REF: ${{ github.head_ref }}')
    const step = /\n {8}run: \|\n(?<body>(?: {10}.*\n)+)/.exec(workflow.slice(from))?.groups?.body ?? ''
    const manifest = (version: string) => `{\n  "name": "synthetic",\n  "version": "${version}"\n}\n`
    // Stands in for the registry: `published` is the line `npm view` prints, and a failure prints none.
    const registry = (published: string | undefined) => {
        const bin = mkdtempSync(join(tmpdir(), 'test-protection-registry-'))
        roots.push(bin)
        writeFileSync(join(bin, 'npm'), published === undefined ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho ${published}\n`, { mode: 0o700 })
        return bin
    }

    it.each([
        ['the Version Packages branch', { HEAD_REF: 'changeset-release/main' }, { 'CHANGELOG.md': 'release\n' }, 'code=true', 'platforms=true'],
        ['a version change on any branch', {}, { 'packages/cockpit/package.json': manifest('2.0.0') }, 'code=true', 'platforms=true'],
        ['the macOS label', { MACOS_LABEL: 'true' }, { 'src.ts': 'changed\n' }, 'code=true', 'platforms=true'],
        ['an ordinary change', {}, { 'src.ts': 'changed\n' }, 'code=true', 'platforms=false'],
        ['another manifest change', {}, { 'packages/cockpit/package.json': manifest('1.0.0').replace('synthetic', 'renamed') }, 'code=true', 'platforms=false'],
        ['a documentation change', {}, { 'README.md': 'changed\n' }, 'code=false', 'platforms=false'],
        ['a push to main', { EVENT_NAME: 'push' }, { 'src.ts': 'changed\n' }, 'code=false', 'platforms=false'],
        ['a version change on one manifest line', {}, { 'packages/cockpit/package.json': '{ "name": "synthetic", "version": "2.0.0" }\n' }, 'code=true', 'platforms=true'],
        // After a failed publish, the next merge is what the release workflow publishes.
        ['a documentation change while the version is unpublished', { PUBLISHED: '' }, { 'README.md': 'changed\n' }, 'code=true', 'platforms=true'],
        ['an ordinary change when the registry cannot answer', { PUBLISHED: undefined }, { 'src.ts': 'changed\n' }, 'code=true', 'platforms=true'],
        // More names than a pipe holds: a reader that stops at its first match must not read as no match.
        ['a change too long for one pipe write', {}, Object.fromEntries(Array.from({ length: 4_000 }, (_, index) => [`src/${String(index).padStart(60, '0')}.ts`, 'new\n'])), 'code=true', 'platforms=false'],
    ] as const)('classifies %s', (_name, env, changed, code, platforms) => {
        const { PUBLISHED: _published, ...settings } = env as Record<string, string | undefined>
        const repo = repository()
        const files = { 'packages/cockpit/package.json': manifest('1.0.0'), 'README.md': 'base\n', 'src.ts': 'base\n' }
        const base = repo.commit(files)
        const head = repo.commit({ ...files, ...changed }, base)
        writeFileSync(join(repo.root, '.git/HEAD'), `${head}\n`)
        const output = join(repo.root, 'github-output')
        const ran = spawnSync('bash', ['-c', step], { cwd: repo.root, encoding: 'utf8',
            env: { ...process.env, EVENT_NAME: 'pull_request', HEAD_REF: 'ordinary', MACOS_LABEL: 'false', GITHUB_OUTPUT: output, ...settings,
                PATH: `${registry('PUBLISHED' in env ? env.PUBLISHED : '1.0.0')}:${process.env.PATH}` } })
        expect(ran.stderr).toBe('')
        expect(ran.status).toBe(0)
        expect(readFileSync(output, 'utf8').split('\n')).toEqual(expect.arrayContaining([code, platforms]))
    })
})

// The same detector judges a consumer's checkout at grade time, over the files its patterns call tests.
describe('test weakening in a consumer checkout', () => {
    const edit = (path: string, removed: string[], added: string[]) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${removed.map(line => `-${line}\n`).join('')}${added.map(line => `+${line}\n`).join('')}`
    const kinds = (diff: string, declared?: string[]) => weakeningFindings(parseDiff(diff), testFilePatterns(declared)).map(row => `${row.path} ${row.kind}`)

    it('flags deleting, skipping, suppressing, removing and loosening tests and narrowing the runner, and passes an ordinary edit', () => {
        const deleted = 'diff --git a/src/a.test.ts b/src/a.test.ts\ndeleted file mode 100644\n--- a/src/a.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-expect(a()).toBe(1)\n'
        expect(kinds(deleted)).toEqual(['src/a.test.ts test-file-removed'])
        expect(kinds(edit('src/a.test.ts', [], ["it.skip('a', () => {})"]))).toEqual(['src/a.test.ts test-skipped'])
        expect(kinds(edit('tests/test_a.py', [], ['@pytest.mark.skip(reason="later")']))).toEqual(['tests/test_a.py test-skipped'])
        expect(kinds(edit('src/a.spec.ts', [], ['// @ts-ignore']))).toEqual(['src/a.spec.ts check-suppressed'])
        expect(kinds(edit('src/a.test.ts', ['expect(a()).toBe(1)'], []))).toEqual(['src/a.test.ts assertions-removed'])
        expect(kinds(edit('src/a.test.ts', ['expect(a()).toBe(1)'], ['expect(a()).toBeDefined()']))).toEqual(['src/a.test.ts assertions-loosened'])
        expect(kinds(edit('vitest.config.ts', [], ["exclude: ['src/slow/**'],"]))).toEqual(['vitest.config.ts test-selection-narrowed'])
        expect(kinds(edit('package.json', ['"test": "vitest run"'], ['"test": "vitest run || true"']))).toEqual(['package.json test-selection-narrowed'])
        // A stronger test, and a source file that merely says skip, are not weakening.
        expect(kinds(edit('src/a.test.ts', ['expect(a()).toBe(1)'], ['expect(a()).toBe(2)', 'expect(b()).toBe(3)']))).toEqual([])
        expect(kinds(edit('src/a.ts', ['const x = 1'], ["it.skip('a')"]))).toEqual([])
        // Declared test_files replace the default layout: tests/ is no longer a test directory.
        expect(kinds(edit('tests/a.ts', [], ["it.skip('a')"]), ['checks/**'])).toEqual([])
        expect(kinds(edit('checks/a.ts', [], ["it.skip('a')"]), ['checks/**'])).toEqual(['checks/a.ts test-skipped'])
    })
})
