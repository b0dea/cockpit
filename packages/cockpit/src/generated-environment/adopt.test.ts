import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadCockpitConfig } from '../config/load.js'
import { checkoutId, cockpitId, holderId, stackId } from '../environment/identity.js'
import { selectStateRoot } from '../environment/state.js'
import { createGeneratedCommandFixture } from '../../test-support/generated-fixtures.js'
import { runSyncAdoption } from './adopt.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './command.js'
import { uninstallGeneratedEnvironment } from './uninstall.js'

const { cleanup, surfaceConsumer } = createGeneratedCommandFixture()
const homes: string[] = []
afterEach(async () => {
    await cleanup()
    await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

// A team's own Claude settings: a formatter hook and permission rules cockpit knows nothing about.
const TEAM_SETTINGS = `${JSON.stringify({
    permissions: { allow: ['Bash(npm run lint)'], deny: ['Read(./.env)'] },
    hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npm run format' }] }] },
}, null, 2)}\n`

async function teamConsumer(name: string) {
    const fixture = await surfaceConsumer(name)
    await mkdir(join(fixture.root, '.claude'), { recursive: true })
    await writeFile(join(fixture.root, '.claude/settings.json'), TEAM_SETTINGS)
    return fixture
}

async function adopt(configPath: string) {
    const outcome = await runSyncAdoption({ configPath, adopt: ['.claude/settings.json'] }, request => syncGeneratedEnvironment(request))
    expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
    return outcome
}

describe('sync --adopt', () => {
    it('names the adopt command when a team settings file is in the way', async () => {
        const { configPath } = await teamConsumer('adopt-conflict')
        const refused = await syncGeneratedEnvironment({ configPath })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'SURFACE_STATE_CONFLICT', target: '.claude/settings.json',
            message: expect.stringContaining('cockpit sync --config <file> --adopt .claude/settings.json'),
        })] })
    })

    it('keeps the team hook and permissions beside the guard hook in the merged file', async () => {
        const { root, configPath } = await teamConsumer('adopt-merge')
        await adopt(configPath)
        expect(await readFile(join(root, 'cockpit/adopted/.claude/settings.json'), 'utf8')).toBe(TEAM_SETTINGS)
        const loaded = await loadCockpitConfig(configPath)
        if (loaded.kind !== 'complete') throw new Error('adopted configuration did not load')
        expect(loaded.result.config.surfaces.adopted).toMatchObject([{ path: '.claude/settings.json', source: 'cockpit/adopted/.claude/settings.json',
            provenance: { kind: 'declared', source: '.claude/settings.json' } }])
        const merged = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))
        expect(merged.permissions).toMatchObject({ allow: ['Bash(npm run lint)'], deny: ['Read(./.env)'] })
        expect(merged.hooks.PostToolUse).toEqual(JSON.parse(TEAM_SETTINGS).hooks.PostToolUse)
        expect(JSON.stringify(merged.hooks.PreToolUse)).toContain('.cockpit/guards/bash-guard.sh')
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    })

    it('reports a hand edit to the merged file and points at the adopted copy', async () => {
        const { root, configPath } = await teamConsumer('adopt-drift')
        await adopt(configPath)
        const path = join(root, '.claude/settings.json')
        await writeFile(path, (await readFile(path, 'utf8')).replace('npm run lint', 'npm run anything'))
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code: 'SURFACE_STATE_CONFLICT', target: '.claude/settings.json',
            message: expect.stringContaining('merged from cockpit/adopted/.claude/settings.json'),
        })] })
    })

    it('restores the team file byte for byte on uninstall', async () => {
        const { root, configPath } = await teamConsumer('adopt-uninstall')
        await adopt(configPath)
        const home = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-adopt-state-')))
        homes.push(home)
        const cockpit = cockpitId({ name: 'generated-environment', mainCheckoutPath: root })
        const checkout = checkoutId({ checkoutPath: root })
        const stack = stackId({ cockpitId: cockpit, checkoutId: checkout, variant: { kind: 'shared' } })
        const selected = await selectStateRoot({ platform: 'linux', home, cockpitId: cockpit })
        if (selected.kind !== 'complete') throw new Error('synthetic state namespace unavailable')
        const removed = await uninstallGeneratedEnvironment({ configPath }, {
            namespace: selected.value, ownerId: holderId({ stackId: stack, checkoutId: checkout, sessionId: 'synthetic-adoption' }),
        }, { authorizeStaleRemoval: async request => ({ format: 'cockpit-stale-removal-approval/v1' as const, digest: request.digest }) })
        expect(removed, JSON.stringify(removed)).toMatchObject({ kind: 'complete' })
        expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe(TEAM_SETTINGS)
    })
})
