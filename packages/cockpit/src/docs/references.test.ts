import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runDocsCheck } from './check.js'

const CONFIG = ['[cockpit]', 'name = "synthetic"', 'siblings_root = "."', '',
    '[[sibling]]', 'slug = "api"', 'dir = "api"', 'mount = "none"', 'acquire = "none"', 'var = "API_DIR"', 'purpose = "Synthetic API"', '',
    '[ports]', 'bases = {}', ''].join('\n')

let root: string

function write(path: string, body: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
}
function git(repository: string, ...args: string[]): void {
    execFileSync('git', ['-C', join(root, repository), '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args], { stdio: 'ignore' })
}
async function check(docs: string) {
    writeFileSync(join(root, 'cockpit.toml'), `${CONFIG}${docs}`)
    const outcome = await runDocsCheck({ configPath: join(root, 'cockpit.toml'), env: process.env }, { execute: executeProbe })
    return { status: outcome.status, findings: outcome.diagnostics.map(row => `${row.code} ${row.message}`) }
}

// The sibling's history deletes a script, renames a guide and drops a make target; its README
// cites all three, plus a path and a target that never existed, which are proposals and stay quiet.
beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-docs-check-')))
    for (const repository of ['.', 'api']) {
        mkdirSync(join(root, repository), { recursive: true })
        execFileSync('git', ['init', '-q', join(root, repository)])
    }
    write('api/scripts/seed.sh', 'echo seed\n')
    write('api/docs/setup.md', '# Setup\n')
    write('api/Makefile', 'build:\n\techo build\n.PHONY: publish\npublish:\n\techo publish\n')
    write('api/config/local.json', '{}\n')
    git('api', 'add', '-A')
    git('api', 'commit', '-qm', 'one')
    git('api', 'rm', '-q', 'scripts/seed.sh')
    // Untracked and ignored, but still on disk: not removed.
    git('api', 'rm', '-q', '--cached', 'config/local.json')
    write('api/.gitignore', 'config/local.json\n')
    git('api', 'add', '.gitignore')
    git('api', 'mv', 'docs/setup.md', 'docs/install.md')
    write('api/Makefile', 'build:\n\techo build\n')
    git('api', 'commit', '-qam', 'two')
    write('api/README.md', ['# API', '',
        'Seed with `scripts/seed.sh`, follow [setup](docs/setup.md), and see `docs/install.md`.',
        'Release with `make publish`; `make park` and `scripts/later.sh` are proposals; copy `config/local.json`.', '',
        '```sh', '$ make build publish', '```', '',
        '```text', 'make publish', '```', ''].join('\n'))
    write('README.md', '# Cockpit\n')
    // A second document citing the same removed path on the same line number is its own finding.
    write('api/GUIDE.md', '# Guide\n\nSeed with `scripts/seed.sh`.\n')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('docs check references', () => {
    it('reports paths and make targets a living doc cites that the history removed, and nothing that never existed', async () => {
        expect(await check('\n[docs]\nliving = ["README.md", "api:*.md"]\n')).toEqual({ status: 2, findings: [
            'DOCS_REFERENCE_REMOVED api:GUIDE.md:3 cites scripts/seed.sh, which the repository history removed',
            'DOCS_REFERENCE_REMOVED api:README.md:3 cites scripts/seed.sh, which the repository history removed',
            'DOCS_REFERENCE_REMOVED api:README.md:3 cites docs/setup.md, which the repository history renamed to docs/install.md',
            'DOCS_TARGET_REMOVED api:README.md:4 runs make publish, a target the Makefiles once defined and no longer do',
            // A shell fence counts; a text fence is output, not a command.
            'DOCS_TARGET_REMOVED api:README.md:7 runs make publish, a target the Makefiles once defined and no longer do',
        ] })
        expect(await check('\n[docs]\nliving = ["README.md"]\n')).toEqual({ status: 0, findings: [] })
    })

    it('refuses without [docs], and reports a declaration that matches nothing', async () => {
        expect(await check('')).toEqual({ status: 2, findings: [expect.stringMatching(/^DOCS_NOT_DECLARED .*has no \[docs\] table/)] })
        expect(await check('\n[docs]\nliving = ["README.md", "notes/**/*.md"]\ndecisions = "api:docs/adr"\n')).toEqual({ status: 2, findings: [
            'DOCS_DECLARATION_UNMATCHED [docs] living entry notes/**/*.md matches no Markdown file, so it checks nothing',
            'DOCS_DECLARATION_UNMATCHED [docs] decisions api:docs/adr holds no Markdown file, so it checks nothing',
        ] })
    })

    it('checks a sibling where cockpit use serves it, not at its declared checkout', async () => {
        git('api', 'worktree', 'add', '-q', '-b', 'feature', join(root, 'api-feature'))
        write('api-feature/NOTES.md', 'Seed with `scripts/seed.sh`.\n')
        write('.cockpit/local/sibling-checkouts', JSON.stringify({ format: 'cockpit-sibling-checkouts/v1', checkouts: { api: join(root, 'api-feature') } }))
        try {
            expect(await check('\n[docs]\nliving = ["api:NOTES.md"]\n')).toEqual({ status: 2, findings: [
                'DOCS_REFERENCE_REMOVED api:NOTES.md:1 cites scripts/seed.sh, which the repository history removed',
            ] })
        } finally { rmSync(join(root, '.cockpit/local/sibling-checkouts')) }
    })
})
