import { describe, expect, it } from 'vitest'

import { mergeAdoptedSurface } from './adoption.js'

const guardHook = { matcher: 'Bash|Edit|Write', hooks: [{ type: 'command', command: '/bin/bash /checkout/.cockpit/guards/bash-guard.sh --harness claudecode' }] }
const cockpitSettings = (permissions: Record<string, unknown> = {}) => `${JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: { additionalDirectories: ['/checkout/app'], ...permissions },
    hooks: { PreToolUse: [guardHook] },
}, null, 2)}\n`

describe('adopted harness settings merge', () => {
    it('refuses an adopted disableAllHooks by name', () => {
        const merged = mergeAdoptedSurface('.claude/settings.json', '{ "disableAllHooks": true, "env": { "TEAM": "1" } }\n', cockpitSettings())
        expect(merged).toMatchObject({ kind: 'refusal', diagnostic: {
            code: 'SURFACE_ADOPTION_REFUSED', target: 'cockpit/adopted/.claude/settings.json#disableAllHooks',
            message: expect.stringContaining('`disableAllHooks`'),
        } })
    })

    it('keeps a cockpit deny authoritative over an adopted allow', () => {
        const adopted = JSON.stringify({ permissions: { allow: ['Bash(git push:*)', 'Bash(npm test)'], deny: ['Read(./.env)'] } })
        const merged = mergeAdoptedSurface('.claude/settings.json', adopted, cockpitSettings({ deny: ['Bash(git push:*)'] }))
        if (merged.kind !== 'complete') throw new Error(merged.diagnostic.message)
        const settings = JSON.parse(merged.bytes)
        expect(settings.permissions.allow).toEqual(['Bash(npm test)'])
        expect(settings.permissions.deny).toEqual(['Bash(git push:*)', 'Read(./.env)'])
        expect(settings.hooks.PreToolUse).toEqual([guardHook])
    })
})
