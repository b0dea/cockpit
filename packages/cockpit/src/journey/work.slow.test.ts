import { afterAll, expect, it } from 'vitest'
import { createProduct, explain, JOURNEY_TIMEOUT, ok, type Product, PRODUCT_FILES, removeScratch } from '../test-support/journey/harness.js'

afterAll(removeScratch)

const ORDER = `---
id: WO-1
objective: The catalogue lists every product.
scope:
  - src/**
  - test.mjs
depends_on: []
gates: [unit]
criteria:
  - id: AC1
    text: The unit tests pass with the full catalogue in place.
    check: { gate: unit }
non_goals: []
---
`

// A change past the 64 KiB a diff was once bounded to: the full gate refused it on first real use.
const largeCatalogue = Array.from({ length: 4000 }, (_, index) => `export const product${index} = { id: ${index}, name: 'Product ${index}' }\n`).join('')

// The layout init gives a single product repository: the repository is its own sibling.
const IN_REPO = PRODUCT_FILES['cockpit.toml']!.replace('slug = "app"\ndir = "app"', 'slug = "shop"\ndir = "."').replace('APP_DIR', 'SHOP_DIR')

function adopted(name: string, cockpitToml = IN_REPO): Product {
    const shop = createProduct(name, { files: { 'cockpit.toml': cockpitToml, 'workorders/WO-1.md': ORDER, 'src/catalog.js': 'export const products = []\n' } })
    ok(shop, ['sync'])
    shop.git('add', '--all')
    shop.git('commit', '--quiet', '--message', 'Adopt cockpit')
    return shop
}

it('passes only the complete gate, fails it when a stage fails, and is not stopped by a large change', () => {
    const shop = adopted('gate')
    expect(ok(shop, ['test-run', '--gate', 'unit']).json?.result).toMatchObject({ verdict: 'PASS', satisfiesGate: true })
    const selected = shop.cockpit(['test-run', '--gate', 'unit', '--select', 'test:lists products'])
    expect(selected.json?.result, explain(selected)).toMatchObject({ verdict: 'PARTIAL', satisfiesGate: false })

    ok(shop, ['work', 'accept', '--work-order', 'WO-1'])
    shop.write('src/catalog.js', largeCatalogue)
    expect(Buffer.byteLength(largeCatalogue)).toBeGreaterThan(64 * 1024)
    expect(ok(shop, ['test-run', '--gate', 'unit']).json?.result).toMatchObject({ verdict: 'PASS', satisfiesGate: true })

    shop.write('test.mjs', "console.error('1 test failed'); process.exit(1)\n")
    const failing = shop.cockpit(['test-run', '--gate', 'unit'])
    expect(failing.status).toBe(2)
    expect(failing.errors).toEqual(['TEST_GATE_UNSATISFIED'])
    expect(failing.json?.result.verdict).toBe('FAIL')
}, JOURNEY_TIMEOUT)

// grading = "checks" is the mode that needs no model: cockpit runs every criterion's check and
// grades by rule. A model-graded order (independent, subagent) is not covered: the evaluator is an
// agent tool's CLI, and no stand-in for one ships with cockpit.
it('accepts, checks, grades and closes a work order, and refuses a grade with changes outside its scope', () => {
    const shop = adopted('grade')
    ok(shop, ['work', 'accept', '--work-order', 'WO-1'])
    shop.write('src/catalog.js', largeCatalogue)
    shop.write('notes.txt', 'outside the order\n')
    expect(ok(shop, ['work', 'check', '--work-order', 'WO-1']).json?.result.state).toBe('checked')
    const outside = shop.cockpit(['work', 'grade', '--work-order', 'WO-1'])
    expect(outside.errors, explain(outside)).toEqual(['WORK_GRADE_UNSATISFIED'])
    expect(outside.json?.result.outOfScope).toEqual(['notes.txt'])

    shop.git('clean', '--quiet', '--force', '--', 'notes.txt')
    expect(ok(shop, ['work', 'grade', '--work-order', 'WO-1']).json?.result.criteria).toEqual([expect.objectContaining({ id: 'AC1', verdict: 'met' })])
    ok(shop, ['work', 'signoff', '--work-order', 'WO-1'])
    expect(ok(shop, ['work', 'status']).json?.result.orders).toEqual([expect.objectContaining({ id: 'WO-1', state: 'done' })])

    // An ad hoc grade always asks an independent evaluator; with none installed it refuses and says so.
    shop.write('criteria.md', '---\ncriteria:\n  - id: AC1\n    text: The unit tests pass.\n    check: { gate: unit }\n---\n')
    const adHoc = shop.cockpit(['grade', '--criteria', 'criteria.md'])
    expect(adHoc.errors).toEqual(['WORK_APPLICATION_REFUSED'])
    expect(adHoc.json?.diagnostics?.[0]?.message).toContain('EVALUATOR_UNAVAILABLE')
}, JOURNEY_TIMEOUT)

// Fails on main: with a sibling that is a plain directory of the cockpit's own repository, as in
// examples/compose-first, the grade diffs the whole repository as that sibling, so an edit to a
// tracked file in scope is reported outside it as `app:src/catalog.js` (WORK_GRADE_UNSATISFIED).
it.fails('grades an edit to a tracked file in scope as in scope when a sibling is a directory of the cockpit repository', () => {
    const shop = adopted('subdirectory-sibling', PRODUCT_FILES['cockpit.toml'])
    ok(shop, ['work', 'accept', '--work-order', 'WO-1'])
    shop.write('src/catalog.js', largeCatalogue)
    ok(shop, ['work', 'grade', '--work-order', 'WO-1'])
}, JOURNEY_TIMEOUT)
