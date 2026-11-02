import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export const LINTER = fileURLToPath(new URL('../../../scripts/docs-lint.mjs', import.meta.url))

export function committedReferenceFixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'reference-closure-')))
    for (const path of [
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'packages/cockpit/package.json',
        'packages/cockpit/tsconfig.build.json',
        'packages/cockpit/cockpit.schema.json',
        'packages/cockpit/libexec',
        'packages/cockpit/src',
        'packages/cockpit/surfaces',
        'packages/cockpit/dist',
        'scripts/diagnostic-inventory.mjs',
        'scripts/diagnostic-inventory.d.mts',
        'scripts/docs-lint.mjs',
        'scripts/docs-lint.d.mts',
    ]) {
        const destination = join(root, path)
        mkdirSync(join(destination, '..'), { recursive: true })
        cpSync(join(ROOT, path), destination, { recursive: true })
    }
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/troubleshooting.md'), [
        '# Troubleshooting',
        '',
        'Foreign maintainer prose.',
        '',
        '<!-- cockpit:diagnostic-index:begin -->',
        'stale diagnostic index',
        '<!-- cockpit:diagnostic-index:end -->',
        '',
    ].join('\n'))
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['add', 'package.json', 'package-lock.json', 'tsconfig.json', 'packages/cockpit/package.json',
        'packages/cockpit/tsconfig.build.json', 'packages/cockpit/cockpit.schema.json',
        'packages/cockpit/libexec', 'packages/cockpit/src',
        'packages/cockpit/surfaces', 'scripts', 'docs/troubleshooting.md'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' })
    writeFileSync(join(root, 'fixture-head.txt'), 'current head\n')
    execFileSync('git', ['add', 'fixture-head.txt'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'advance'], { cwd: root, stdio: 'ignore' })
    return root
}

export function malformedGitBoundary(root: string) {
    const bin = join(root, 'fixture-bin')
    const statePath = join(root, 'fixture-git-state.json')
    const realGit = realpathSync(execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim())
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), [
        `#!${process.execPath}`,
        "import { readFileSync, writeFileSync } from 'node:fs'",
        "import { spawnSync } from 'node:child_process'",
        `const statePath = ${JSON.stringify(statePath)}`,
        `const realGit = ${JSON.stringify(realGit)}`,
        "const arguments_ = process.argv.slice(2)",
        "const state = JSON.parse(readFileSync(statePath, 'utf8'))",
        "if (arguments_[0] === 'cat-file' && arguments_[1] === 'blob') state.sourceBlobs += 1",
        "if (arguments_[0] === 'show' && arguments_[1]?.includes(':packages/cockpit/src/')) state.sourceShows += 1",
        "const result = spawnSync(realGit, arguments_, { cwd: process.cwd(), encoding: null, input: readFileSync(0), maxBuffer: 64 * 1024 * 1024 })",
        "let stdout = result.stdout ?? Buffer.alloc(0)",
        "if (arguments_[0] === 'ls-tree') {",
        "  state.seen += 1",
        "  if (state.seen === state.corruptAt) {",
        "    if (state.mutation === 'leading') stdout = Buffer.concat([Buffer.from([0]), stdout])",
        "    if (state.mutation === 'doubled') {",
        "      const boundary = stdout.indexOf(0)",
        "      stdout = Buffer.concat([stdout.subarray(0, boundary + 1), Buffer.from([0]), stdout.subarray(boundary + 1)])",
        "    }",
        "    if (state.mutation === 'trailing') stdout = Buffer.concat([stdout, Buffer.from([0])])",
        "    if (state.mutation === 'missing') stdout = stdout.subarray(0, stdout.length - 1)",
        "  }",
        "}",
        "writeFileSync(statePath, JSON.stringify(state))",
        "writeFileSync(1, stdout)",
        "writeFileSync(2, result.stderr ?? Buffer.alloc(0))",
        "process.exit(result.status ?? 1)",
        '',
    ].join('\n'), { mode: 0o755 })
    return {
        path: bin,
        set(mutation: 'valid' | 'leading' | 'doubled' | 'trailing' | 'missing', corruptAt: number) {
            writeFileSync(statePath, JSON.stringify({ mutation, corruptAt, seen: 0, sourceBlobs: 0, sourceShows: 0 }))
        },
        state(): { seen: number; sourceBlobs: number; sourceShows: number } {
            return JSON.parse(readFileSync(statePath, 'utf8')) as { seen: number; sourceBlobs: number; sourceShows: number }
        },
    }
}
