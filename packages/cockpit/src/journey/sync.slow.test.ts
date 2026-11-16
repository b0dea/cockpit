import { afterAll, expect, it } from 'vitest'
import { createProduct, JOURNEY_TIMEOUT, ok, removeScratch } from '../test-support/journey/harness.js'

afterAll(removeScratch)

it('applies a narrowing edit to cockpit.toml on an agent\'s sync, and a widening one only on a person\'s yes at a terminal', () => {
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

    // A person runs it in a terminal of their own, reads what widens and answers yes; no digest is typed.
    const confirmed = shop.cockpit(['sync', '--interactive'], { json: false, answer: 'yes' })
    expect(confirmed.status, confirmed.stdout).toBe(0)
    expect(confirmed.stdout).toContain('guards.allow')
    expect(confirmed.stdout.match(/\[yes\/no\]/g)).toHaveLength(1)
    // check failed with GUARD_CONFIG_WIDENED before the yes; it passes once the edit is applied.
    ok(shop, ['check'])
}, JOURNEY_TIMEOUT)
