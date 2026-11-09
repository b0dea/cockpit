import { describe, expect, it } from 'vitest'
import { parseCockpitConfigBytes } from '../config/load.js'
import { sha256Hex } from '../sha256.js'
import { guardConfigChange } from './policy-change.js'
import { pinnedPolicyDenial } from './policy-pin.js'
import { parseGuardInput } from './invocation-parser.js'

const root = '/synthetic/cockpit'
const config = `${root}/cockpit.toml`
const current = [
    '[cockpit]', 'name = "synthetic"', '',
    '[ports]', 'bases = {}', '',
    '[work]', 'grading = "independent"', '',
    '[work.gates]', 'accept = "person"', '',
    '[autonomy]', 'mcp_approve = "person"', '',
    '[mcp]', 'approved = {}', '',
    '[guards]', 'protected_branches = ["main"]', '',
    '[[sibling]]', 'slug = "app"', 'dir = "app"', 'mount = "none"', 'acquire = "none"',
    'var = "APP_DIR"', 'purpose = "the application"', '',
].join('\n')
const decide = (payload: Record<string, unknown>, isConfig: (path: string) => boolean = path => path === config, text = current) => {
    const parsed = parseGuardInput({ hook_event_name: 'PreToolUse', cwd: root, ...payload })
    if (parsed.status !== 'parsed') throw new Error(parsed.reason)
    return pinnedPolicyDenial(parsed, text, isConfig)?.decision
}
const edit = (old: string, replacement: string, file = config, text = current) =>
    decide({ tool_name: 'Edit', tool_input: { file_path: file, old_string: old, new_string: replacement } }, undefined, text)

describe('guard policy pin', () => {
    it('allows revoking an MCP approval through edit, write and patch, then admits sync without allowing reapproval', () => {
        const approved = 'approved = { docs = "' + 'a'.repeat(64) + '" }'
        const prior = current.replace('approved = {}', approved)
        const payloads = [
            { tool_name: 'Edit', tool_input: { file_path: config, old_string: approved, new_string: 'approved = {}' } },
            { tool_name: 'Write', tool_input: { file_path: config, content: current } },
            { tool_name: 'apply_patch', tool_input: { command:
                `*** Begin Patch\n*** Update File: ${config}\n@@\n-${approved}\n+approved = {}\n*** End Patch` } },
        ]
        for (const payload of payloads) expect(decide(payload, undefined, prior)).toBeUndefined()
        const revoked = parseCockpitConfigBytes(Buffer.from(current))
        if (!revoked) throw new Error('synthetic configuration must parse')
        expect(guardConfigChange(sha256Hex(prior), Buffer.from(prior), { sha256: sha256Hex(current), config: revoked }))
            .toEqual({ kind: 'non-widening' })
        expect(edit('approved = {}', approved)).toBe('deny')
        expect(edit(approved, approved.replace('a'.repeat(64), 'b'.repeat(64)), config, prior)).toBe('deny')
        expect(edit(approved, approved + '\nfuture = true', config, prior)).toBe('deny')
    })

    it.each(['person', 'agent'])('holds MCP tool expansion for a person when server approval belongs to %s', authority => {
        const text = current.replace('mcp_approve = "person"', `mcp_approve = "${authority}"`)
        const declaration = 'approved = {}'
        const restrict = (tools: string) => `${declaration}\nallowed_tools = { docs = ${tools} }`
        for (const [from, to] of [
            [declaration, restrict('["read_record", "search_records"]')],
            [restrict('["read_record", "search_records"]'), restrict('["read_record"]')],
            [restrict('["read_record"]'), restrict('[]')],
        ]) {
            const prior = text.replace(declaration, from!)
            const next = text.replace(declaration, to!)
            for (const payload of [
                { tool_name: 'Edit', tool_input: { file_path: config, old_string: from, new_string: to } },
                { tool_name: 'Write', tool_input: { file_path: config, content: next } },
                { tool_name: 'apply_patch', tool_input: { command:
                    `*** Begin Patch\n*** Update File: ${config}\n@@\n${from!.split('\n').map(line => `-${line}`).join('\n')}\n${to!.split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch` } },
            ]) expect(decide(payload, undefined, prior)).toBeUndefined()
            const parsed = parseCockpitConfigBytes(Buffer.from(next))
            const original = parseCockpitConfigBytes(Buffer.from(prior))
            if (!parsed || !original) throw new Error('synthetic configuration must parse')
            expect(guardConfigChange(sha256Hex(prior), Buffer.from(prior), { sha256: sha256Hex(next), config: parsed }))
                .toEqual({ kind: 'non-widening' })
            expect(edit(to!, from!, config, next)).toBe('deny')
            expect(guardConfigChange(sha256Hex(next), Buffer.from(next), { sha256: sha256Hex(prior), config: original }))
                .toEqual({ kind: 'widening', fields: ['mcp.allowed_tools.docs'] })
        }
        expect(edit(declaration, restrict('true'), config, text)).toBe('deny')
    })

    it('denies an edit, write or patch that changes [work], [work.gates], [autonomy] or a person-approved [mcp], and admits one elsewhere', () => {
        expect(edit('grading = "independent"', 'grading = "self"')).toBe('deny')
        expect(edit('grading = "independent"', 'grading = "subagent"')).toBe('deny')
        expect(edit('grading = "independent"', 'grading = "off"')).toBe('deny')
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

    it('denies what it cannot apply: an unmatched or ambiguous edit, text it was not given, unparseable TOML, or a shell command that can write it', () => {
        expect(edit('not in the file', 'x')).toBe('deny')
        expect(edit('"', "'")).toBe('deny')
        expect(edit('[work]', '[work')).toBe('deny')
        expect(decide({ tool_name: 'Edit', tool_input: { file_path: config } })).toBe('deny')
        // Only a command that can write the file is refused: a redirect onto it, a writer, an in-place
        // editor, a program spelled `git` that is not the search path's, or any program given a write
        // option, wrapped or not and whichever cockpit session runs it.
        for (const command of [`sed -i '' 's/person/agent/' ${config}`, `printf x >> ${config}`, `cp other.toml ${config}`,
            `/usr/bin/sed -i 's/reset = "person"/reset = "agent"/' cockpit.toml`, '/bin/cp other.toml cockpit.toml', 'mv cockpit.toml old.toml',
            "perl -pi -e 's/person/agent/' cockpit.toml", 'echo x | tee cockpit.toml', 'git checkout -- cockpit.toml', './git add cockpit.toml',
            "timeout 5 sed -i 's/person/agent/' cockpit.toml", 'sort -o cockpit.toml other.toml', 'node /tmp/w.js --out=cockpit.toml',
            'node /tmp/w.js --output cockpit.toml', 'prettier --write cockpit.toml', 'cat other.toml > cockpit.toml',
            "npx --no cockpit session --config cockpit.toml -- sed -i '' 's/person/agent/' cockpit.toml",
            'npx --no cockpit session --config cockpit.toml -- npx --no cockpit session -- cp other.toml cockpit.toml',
            "npx --no cockpit exec --service app -- sed -i 's/person/agent/' cockpit.toml"]) {
            expect(decide({ tool_name: 'Bash', tool_input: { command } }), command).toBe('deny')
        }
        const parsed = parseGuardInput({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Bash', tool_input: { command: 'mv cockpit.toml old.toml' } })
        if (parsed.status !== 'parsed') throw new Error(parsed.reason)
        expect(pinnedPolicyDenial(parsed, current, path => path === config)?.reason).toMatch(/^Refusing a shell command that can write the cockpit configuration/)
        // Reading it, under any program or launcher spelling, changes nothing.
        for (const command of [`cat ${config}`, `git add ${config}`, 'git -C . diff -- cockpit.toml', 'printf x > notes.txt',
            'diff cockpit.toml other.toml', 'sort cockpit.toml', 'pnpm exec cockpit check --config cockpit.toml',
            '/usr/local/bin/node ./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml', 'node /tmp/w.js cockpit.toml',
            'npx --no cockpit sync --config cockpit.toml', './node_modules/.bin/cockpit check --config=cockpit.toml',
            'npx --no cockpit session --config cockpit.toml -- cat cockpit.toml', 'npx --no cockpit exec --service app -- cat cockpit.toml']) {
            expect(decide({ tool_name: 'Bash', tool_input: { command } }), command).toBeUndefined()
        }
        // A hard link or another spelling of the configuration is the configuration.
        expect(edit('accept = "person"', 'accept = "agent"', `${root}/alias.toml`)).toBeUndefined()
        expect(decide({ tool_name: 'Edit', tool_input: { file_path: `${root}/alias.toml`, old_string: 'accept = "person"', new_string: 'accept = "agent"' } },
            path => path === config || path === `${root}/alias.toml`)).toBe('deny')
    })
})
