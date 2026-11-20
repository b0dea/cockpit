import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composeTargets, observeTakeover } from './takeover.js'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('adoption takeover', () => {
    it('names the Makefile targets that drive Compose, directly or through a variable', () => {
        expect(composeTargets([
            'COMPOSE ?= docker compose -f compose.yml',
            'up:', '\t$(COMPOSE) up -d',
            'down stop:', '\tdocker compose \\', '\t  down',
            'reset: down', '\tdocker-compose down -v && ./seed.sh',
            '.PHONY: up down', 'lint:', '\tnpm run lint',
        ].join('\n'))).toEqual(['up', 'down', 'stop', 'reset'])
    })

    it('lists the agent settings and Compose verbs cockpit takes over, and the files that stay the repository\'s', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-takeover-')))
        scratch.push(root)
        mkdirSync(join(root, '.claude'))
        mkdirSync(join(root, 'api'))
        writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }] } }))
        writeFileSync(join(root, 'api/Makefile'), 'up:\n\tdocker compose up -d\ntest:\n\tgo test ./...\n')
        writeFileSync(join(root, 'api/compose.yml'), 'services: {}\n')
        const takeover = await observeTakeover({ root, repositories: [{ path: 'api' }] })
        expect(takeover.takesOver).toEqual([
            { path: '.claude/settings.json', note: expect.stringContaining('its hooks (PreToolUse: ./guard.sh) keep running beside cockpit\'s guard') },
            { path: 'api/Makefile', note: expect.stringMatching(/^make up drives Docker Compose.*Stop it with the old command before the first cockpit up/) },
        ])
        expect(takeover.staysYours.map(row => row.path)).toEqual(['api/Makefile', 'api/compose.yml'])
    })
})
