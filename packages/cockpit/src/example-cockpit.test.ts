import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { repositoryIdentity } from './environment/repository-identity.js'
import { walkMarkdownProse } from '../../../scripts/docs-lint.ts'
import { inventory } from '../test-support/example-inventory.js'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
// Pages a person reads; agent instructions and shipped templates are executable, not documentation.
const HUMAN_PAGE = /^(?:(?!AGENTS\.md$|CLAUDE\.md$)[^/]+\.md|(?:docs|examples|\.changeset)\/.+(?<!\.(?:agent|skill|prompt)\.md)|packages\/cockpit\/(?:README|CHANGELOG)\.md)$/

const developer = { kind: 'human-only', reason: 'developer prerequisite in the source checkout' } as const
const packageInstall = { kind: 'human-only', reason: 'package installation prerequisite' } as const
const operator = { kind: 'human-only', reason: 'operator input, approval, or estate state required' } as const
const runtime = { kind: 'human-only', reason: 'runtime or destructive environment operation' } as const
const executed = { kind: 'executed', reason: 'run by the example acceptance tests' } as const
const DOCUMENTED_SHELL_BLOCKS = new Map<string, readonly (typeof developer | typeof packageInstall | typeof operator | typeof runtime | typeof executed)[]>([
    ['CONTRIBUTING.md', [developer, developer, developer]],
    ['README.md', [runtime, packageInstall, operator]],
    ['docs/contributing/style.md', [developer]],
    ['docs/environment.md', [operator, runtime, runtime, runtime]],
    ['docs/getting-started.md', [packageInstall, operator, operator, operator, runtime, operator, operator, operator, operator, operator, operator,
        runtime, runtime, runtime, operator, developer]],
    ['docs/harness-surfaces.md', [operator, operator, operator, operator, operator]],
    ['docs/joining-a-team.md', [packageInstall, operator, operator]],
    ['docs/contributing/releasing.md', [operator, operator, developer, developer]],
    ['docs/troubleshooting.md', [operator, operator]],
    ['docs/contributing/testing.md', [developer, developer]],
    ['docs/tutorial.md', [operator, operator, operator, operator, runtime, operator]],
    ['docs/work-and-browser.md', [operator]],
    ['packages/cockpit/README.md', [packageInstall]],
    ['examples/minimal/README.md', [executed, runtime]],
    ['examples/docs-only/README.md', [executed]],
    ['examples/compose-first/README.md', [executed, runtime]],
    ['examples/extended/README.md', [executed]],
])

function publicShellInventory(documents: ReadonlyMap<string, string>) {
    const blocks: Array<{ path: string; block: number; kind: string; reason: string }> = []
    for (const [path, body] of [...documents].sort(([left], [right]) => left.localeCompare(right))) {
        if (!HUMAN_PAGE.test(path)) continue
        const walked = walkMarkdownProse(body)
        const fences = walked.fences.filter(fence => /^(?:sh|bash|shell)(?:\s|$)/.test(fence.info))
        const policy = DOCUMENTED_SHELL_BLOCKS.get(path) ?? []
        const count = Math.max(fences.length, policy.length)
        for (let block = 0; block < count; block += 1) {
            const classification = policy[block]
            blocks.push({ path, block: block + 1, kind: fences[block] && classification ? classification.kind : 'unclassified',
                reason: fences[block] && classification ? classification.reason : 'shell block and classification table differ' })
        }
    }
    for (const path of DOCUMENTED_SHELL_BLOCKS.keys()) if (!documents.has(path)) {
        blocks.push({ path, block: 0, kind: 'unclassified', reason: 'classified public document is missing' })
    }
    return blocks
}

describe('the public example cockpits', () => {
    it('rejects undocumented or machine-local command dependencies', () => {
        const exampleRoot = join(repositoryRoot, 'examples/compose-first')
        const readme = readFileSync(join(exampleRoot, 'README.md'), 'utf8')
        expect(() => inventory(readme)).not.toThrow()
        expect(() => inventory(`${readme}\n\`\`\`sh unknown\ncockpit doctor --config cockpit.toml\n\`\`\`\n`))
            .toThrow('shell command block is not classified')
        expect(() => inventory(readme.replace('cockpit.toml --json', '$HOME/cockpit.toml --json')))
            .toThrow('machine-local path')
        for (const example of ['minimal', 'docs-only', 'compose-first', 'extended']) {
            const commands = inventory(readFileSync(join(repositoryRoot, 'examples', example, 'README.md'), 'utf8'))
            const cockpitExecutables = [...commands.executable, ...commands.humanOnly].flat()
                .filter(token => token === 'cockpit' || !token.startsWith('@') && token.endsWith('/cockpit'))
            expect(new Set(cockpitExecutables), example).toEqual(new Set(['./node_modules/.bin/cockpit']))
            // preflight compares a declared remote with the checkout only through a hosted https or
            // ssh identity, and refuses a local path; an example must not teach a remote it refuses.
            for (const file of readdirSync(join(repositoryRoot, 'examples', example)).filter(name => /^cockpit.*\.toml$/.test(name))) {
                const declared = parseToml(readFileSync(join(repositoryRoot, 'examples', example, file), 'utf8')) as { sibling?: { slug: string; remote?: string }[] }
                for (const sibling of declared.sibling ?? []) {
                    if (sibling.remote !== undefined) expect(repositoryIdentity(sibling.remote).kind, `${example}/${file} ${sibling.slug}`).toBe('known')
                }
            }
        }
    })

    it('inventories every public shell block as executed or human-only with an owner reason', () => {
        const documents = new Map(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: repositoryRoot, encoding: 'utf8' })
            .split('\0').filter(Boolean)
            .map(path => [path, readFileSync(join(repositoryRoot, path), 'utf8')] as const))
        const classified = publicShellInventory(documents)
        expect(classified.filter(row => row.kind === 'unclassified')).toEqual([])
        expect(classified.filter(row => row.kind === 'executed')).toEqual([
            { path: 'examples/compose-first/README.md', block: 1, ...executed },
            { path: 'examples/docs-only/README.md', block: 1, ...executed },
            { path: 'examples/extended/README.md', block: 1, ...executed },
            { path: 'examples/minimal/README.md', block: 1, ...executed },
        ])
        expect(classified.filter(row => row.kind === 'human-only').every(row => row.reason.length > 0)).toBe(true)

        const planted = new Map(documents)
        planted.set('docs/environment.md', `${planted.get('docs/environment.md')}\n\`\`\`sh\ncockpit unknown-command\n\`\`\`\n`)
        expect(publicShellInventory(planted).filter(row => row.kind === 'unclassified')).toContainEqual({
            path: 'docs/environment.md', block: 5, kind: 'unclassified', reason: 'shell block and classification table differ',
        })
    })
})
