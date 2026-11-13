import { describe, expect, it } from 'vitest'

import { instructionFrontmatterAsk } from './instruction-frontmatter.js'

const root = '/synthetic/cockpit'
const skill = `${root}/.claude/skills/probe/SKILL.md`
const write = (path: string, content: string) => ({ tool: 'Write', cwd: root, paths: [path], content: { kind: 'write' as const, path, content } })
const edit = (path: string, old: string, replacement: string) => ({ tool: 'Edit', cwd: root, paths: [path], content: { kind: 'replace' as const, path, old, new: replacement, all: false } })

describe('instruction frontmatter', () => {
    it('asks for a Write or Edit that leaves a skill, command or agent registering hooks or MCP servers, and allows any other text', () => {
        const current = '---\nname: probe\ndescription: Probe the hooks of a repository.\n---\nBody.\n'
        const read = (path: string) => path === skill ? current : undefined
        const decide = (input: Parameters<typeof instructionFrontmatterAsk>[0]) => instructionFrontmatterAsk(input, read)?.decision ?? 'allow'
        for (const [input, decision] of [
            [write(skill, current), 'allow'],
            [write(skill, '---\nname: probe\nhooks:\n  PreToolUse: []\n---\n'), 'ask'],
            [write(`${root}/pkg/.claude/commands/deep/run.md`, '\n---\nmcpServers:\n  x: {}\n---\n'), 'ask'],
            [write(`${root}/.claude/agents/reviewer.md`, '---\n"\\u0068ooks": {}\n---\n'), 'ask'],
            [write(skill, '---\nbase: &b {hooks: {}}\n<<: *b\n---\n'), 'ask'],
            // Frontmatter Claude Code may read differently from the guard is not proven safe.
            [write(skill, '---\nname: probe\nname: twice\n---\n'), 'ask'],
            [write(skill, 'No frontmatter.\nhooks: {}\n'), 'allow'],
            // A body that runs a shell command as the skill loads, and a grant of the shell tool, ask too.
            [write(skill, '---\nname: probe\n---\nThe date is !`date`.\n'), 'ask'],
            [write(skill, '---\nname: probe\n---\n```!\ndate\n```\n'), 'ask'],
            [write(skill, '---\nname: probe\nallowed-tools: Read, Bash(git status:*)\n---\n'), 'ask'],
            [write(skill, '---\nname: probe\nallowed-tools:\n  - Read\n  - bash\n---\n'), 'ask'],
            [write(skill, '---\nname: probe\nallowed-tools: [Read, Grep]\n---\nRun `npm test`.\n'), 'allow'],
            // An edit is judged by the text it leaves.
            [edit(skill, 'name: probe\n', 'name: probe\nhooks: {}\n'), 'ask'],
            [edit(skill, 'Body.', 'Another body.'), 'allow'],
            [edit(skill, 'absent text', 'hooks: {}'), 'ask'],
            // Any other file, and any other tool, is not this check's.
            [write(`${root}/docs/hooks.md`, '---\nhooks: {}\n---\n'), 'allow'],
            [{ ...write(skill, current), tool: 'Bash' }, 'allow'],
        ] as const) expect(decide(input), JSON.stringify(input.content)).toBe(decision)
    })
})
