import { afterAll, expect, it } from 'vitest'
import { createProduct, JOURNEY_TIMEOUT, ok, removeScratch } from '../test-support/journey/harness.js'

afterAll(removeScratch)

it('applies a narrowing edit to cockpit.toml on an agent\'s sync and refuses a widening one until a person syncs', () => {
    const shop = createProduct('shop')
    ok(shop, ['sync'])
    shop.git('add', '--all')
    shop.git('commit', '--quiet', '--message', 'Adopt cockpit')

    shop.write('cockpit.toml', shop.read('cockpit.toml').replace('purpose = "Synthetic app"', 'purpose = "Storefront app"'))
    expect(shop.cockpit(['check']).status).toBe(2)
    expect(ok(shop, ['sync']).json?.result.changes).toContainEqual({ operation: 'write', path: 'AGENTS.md' })
    expect(shop.read('AGENTS.md')).toContain('Storefront app')
    ok(shop, ['check'])

    const settings = shop.read('.claude/settings.json')
    shop.write('cockpit.toml', `${shop.read('cockpit.toml')}
[[guards.allow]]
argv = ["make", "deploy-preview"]
reason = "Deploys a throwaway preview"
`)
    const check = shop.cockpit(['check'])
    expect(check.status).toBe(2)
    expect(check.errors).toContain('GUARD_CONFIG_WIDENED')
    const sync = shop.cockpit(['sync'])
    expect(sync.status).toBe(2)
    expect(sync.errors).toContain('GUARD_CONFIG_WIDENED')
    expect(shop.read('.claude/settings.json')).toBe(settings)
}, JOURNEY_TIMEOUT)
