import { afterAll, expect, it } from 'vitest'
import { createProduct, exists, explain, JOURNEY_TIMEOUT, ok, removeScratch } from '../test-support/journey/harness.js'

afterAll(removeScratch)

// The answers an agent writes after asking the person, as docs/getting-started.md "Without a
// terminal" describes; compose_files = [] adopts the instructions and guards before the runtime.
const ANSWERS = `[cockpit]
name = "shop"

[[sibling]]
slug = "shop"
dir = "."
mount = "always"
acquire = "none"
var = "SHOP_DIR"
purpose = "Synthetic shop"

[ports]
bases = {}

[environment]
test_data = { seeded_data = false, signed_in_users = false }
compose_files = []

[testing]
stages = [{ id = "unit", command = ["npm", "test"], requires_stack = false }]
gates = [{ id = "all", tier = "full", stages = ["unit"], changes = "Any behaviour of the shop" }]

[guards]
hosted_db_hosts = []
vendor_endpoint_hosts = []

[work]
grading = "checks"
`

it('adopts a product without a terminal, then check catches a hand edit that sync refuses to overwrite', () => {
    const shop = createProduct('shop', { files: { 'cockpit.toml': null, 'answers.toml': ANSWERS } })
    const init = (...args: string[]) => shop.cockpit(['init', shop.root, '--target', 'claudecode,codexcli,opencode', ...args], { config: false })
    const preview = init()
    expect(preview.status, explain(preview)).toBe(0)
    expect(exists(shop, 'cockpit.toml')).toBe(false)
    const digest = preview.json?.result.previewSha256
    const answered = init('--accept-preview', digest, '--answers', 'answers.toml')
    expect(answered.json?.result.question, explain(answered)).toMatchObject({ field: 'configuration.defaults', expectedSha256: expect.any(String) })
    const accepted = init('--accept-preview', digest, '--answers', 'answers.toml', '--accept-defaults', answered.json?.result.question.expectedSha256)
    expect(accepted.status, explain(accepted)).toBe(0)
    expect(accepted.json?.result.stage).toBe('surfaces-verified')

    ok(shop, ['sync'])
    ok(shop, ['check'])
    expect(ok(shop, ['doctor']).errors).toEqual([])
    for (const path of ['cockpit.toml', 'CLAUDE.md', '.claude/settings.json', '.codex/hooks.json', 'opencode.jsonc', '.agents/skills/cockpit-work/SKILL.md']) {
        expect(exists(shop, path), path).toBe(true)
    }
    expect(shop.read('AGENTS.md')).toContain('Team notes stay outside the regions cockpit writes.')

    const skill = '.claude/skills/cockpit-work/SKILL.md'
    const edited = `${shop.read(skill)}\nA hand edit.\n`
    shop.write(skill, edited)
    const drift = shop.cockpit(['check'])
    expect(drift.status).toBe(2)
    expect(drift.errors).toContain('SURFACE_STATE_CONFLICT')
    const refused = shop.cockpit(['sync'])
    expect(refused.status).toBe(2)
    expect(refused.errors).toContain('SURFACE_STATE_CONFLICT')
    expect(shop.read(skill)).toBe(edited)
}, JOURNEY_TIMEOUT)
