import { describe, expect, it } from 'vitest'
import { pinnedPolicyDenial } from './policy-pin.js'
import { parseGuardInput } from './invocation-parser.js'

const root = '/synthetic/cockpit'
const config = `${root}/cockpit.toml`
const current = [
    '[cockpit]', 'name = "synthetic"', '',
    '[work]', 'grading = "independent"', '',
    '[work.gates]', 'accept = "person"', '',
    '[autonomy]', 'mcp_approve = "person"', '',
    '[mcp]', 'approved = {}', '',
    '[guards]', 'protected_branches = ["main"]', '',
].join('\n')
const decide = (payload: Record<string, unknown>, isConfig: (path: string) => boolean = path => path === config, text = current) => {
    const parsed = parseGuardInput({ hook_event_name: 'PreToolUse', cwd: root, ...payload })
    if (parsed.status !== 'parsed') throw new Error(parsed.reason)
    return pinnedPolicyDenial(parsed, text, isConfig)?.decision
}
const edit = (old: string, replacement: string, file = config, text = current) =>
    decide({ tool_name: 'Edit', tool_input: { file_path: file, old_string: old, new_string: replacement } }, undefined, text)

describe('guard policy pin', () => {
    it('denies an edit, write or patch that changes [work], [work.gates], [autonomy] or a person-approved [mcp], and admits one elsewhere', () => {
        expect(edit('grading = "independent"', 'grading = "self"')).toBe('deny')
        expect(edit('accept = "person"', 'accept = "agent"')).toBe('deny')
        expect(edit('mcp_approve = "person"', 'mcp_approve = "agent"')).toBe('deny')
        expect(edit('approved = {}', 'approved = { docs = "' + 'a'.repeat(64) + '" }')).toBe('deny')
        // Unset, a person approves MCP servers, so an agent cannot approve the one it declared either.
        expect(edit('approved = {}', 'approved = { docs = "' + 'a'.repeat(64) + '" }', config, current.replace('mcp_approve = "person"', ''))).toBe('deny')
        expect(edit('approved = {}', 'approved = { docs = "' + 'a'.repeat(64) + '" }', config, current.replace('mcp_approve = "person"', 'mcp_approve = "agent"'))).toBeUndefined()
        // A table added where none was is a change too.
        expect(edit('[guards]', '[work.gates]\nsignoff = "agent"\n\n[guards]')).toBe('deny')
        expect(edit('protected_branches = ["main"]', 'protected_branches = ["main", "release"]')).toBeUndefined()
        expect(edit('name = "synthetic"', 'name = "renamed"')).toBeUndefined()
        expect(edit('accept = "person"', 'accept = "agent"', `${root}/other.toml`)).toBeUndefined()
        expect(decide({ tool_name: 'Write', tool_input: { file_path: config, content: current.replace('person"', 'agent"') } })).toBe('deny')
        expect(decide({ tool_name: 'Write', tool_input: { file_path: config, content: current.replace('"synthetic"', '"other"') } })).toBeUndefined()
        const patch = (minus: string, plus: string) => decide({ tool_name: 'apply_patch', tool_input: { command:
            `*** Begin Patch\n*** Update File: ${config}\n@@\n [work.gates]\n-${minus}\n+${plus}\n*** End Patch` } })
        expect(patch('accept = "person"', 'accept = "agent"')).toBe('deny')
        expect(decide({ tool_name: 'apply_patch', tool_input: { command:
            `*** Begin Patch\n*** Update File: ${config}\n@@\n [guards]\n-protected_branches = ["main"]\n+protected_branches = []\n*** End Patch` } })).toBeUndefined()
    })

    it('denies what it cannot apply: an unmatched or ambiguous edit, text it was not given, unparseable TOML, or a shell write', () => {
        expect(edit('not in the file', 'x')).toBe('deny')
        expect(edit('"', "'")).toBe('deny')
        expect(edit('[work]', '[work')).toBe('deny')
        expect(decide({ tool_name: 'Edit', tool_input: { file_path: config } })).toBe('deny')
        // A path or `node <script>` may spell the installed cockpit, but only cockpit's own --config
        // operand is left to the guard's launcher proof; any other naming may be a writer under that
        // spelling, and a session's command is judged as a command of its own.
        for (const command of [`sed -i '' 's/person/agent/' ${config}`, `printf x >> ${config}`, `cp other.toml ${config}`,
            `/usr/bin/sed -i 's/reset = "person"/reset = "agent"/' cockpit.toml`, '/bin/cp other.toml cockpit.toml', 'node /tmp/w.js cockpit.toml',
            "npx --no cockpit session --config cockpit.toml -- sed -i '' 's/person/agent/' cockpit.toml",
            'npx --no cockpit session --config cockpit.toml -- npx --no cockpit session -- cp other.toml cockpit.toml',
            'node /tmp/w.js --out=cockpit.toml', './git add cockpit.toml']) {
            expect(decide({ tool_name: 'Bash', tool_input: { command } }), command).toBe('deny')
        }
        for (const command of [`cat ${config}`, `git add ${config}`, 'git -C . diff -- cockpit.toml', 'printf x > notes.txt',
            'npx --no cockpit sync --config cockpit.toml', './node_modules/.bin/cockpit check --config=cockpit.toml',
            'npx --no cockpit session --config cockpit.toml -- cat cockpit.toml']) {
            expect(decide({ tool_name: 'Bash', tool_input: { command } }), command).toBeUndefined()
        }
        // A hard link or another spelling of the configuration is the configuration.
        expect(edit('accept = "person"', 'accept = "agent"', `${root}/alias.toml`)).toBeUndefined()
        expect(decide({ tool_name: 'Edit', tool_input: { file_path: `${root}/alias.toml`, old_string: 'accept = "person"', new_string: 'accept = "agent"' } },
            path => path === config || path === `${root}/alias.toml`)).toBe('deny')
    })
})
