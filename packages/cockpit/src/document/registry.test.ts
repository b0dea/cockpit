import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { CockpitConfig, mounted } from '../schema.js'
import { emitToml } from '../emit.js'
import { gaps, parseRegistry, type DocumentedSibling } from './registry.js'

// The fixtures are synthetic, and each row exists to hold one property that a real registry
// turned out to depend on. Adding a row is cheap; changing one silently retires whatever
// failure it was standing in for, so change the assertion in the same edit.
const fixture = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../../../../fixtures/registries/${name}`, import.meta.url)), 'utf8')

/**
 * Build a config from documented rows, so the round-trip is asserted end to end.
 *
 * `answers` stands in for the operator confirming the gaps `document` reports. Nothing here
 * invents one: a test that filled them silently would prove the opposite of the point.
 */
function toConfig(
    name: string,
    siblings: DocumentedSibling[],
    answers: Record<string, string> = {},
    operatorGates: readonly string[] = [],
) {
    return CockpitConfig.parse({
        cockpit: { name },
        sibling: siblings.map((s) => ({
            slug: s.slug,
            dir: s.dir,
            ...(s.remote ? { remote: s.remote } : {}),
            ...(s.branch ? { branch: s.branch } : {}),
            mount: s.mount.value,
            acquire: s.acquire.value,
            var: s.var,
            ...(answers[s.slug] ? { host_reason: answers[s.slug] } : {}),
            ...(operatorGates.includes(s.slug) ? { gate: 'operator' } : {}),
            purpose: s.purpose,
        })),
        ports: { bases: { HTTP_PORT: 80 } },
    })
}

describe('lane dialect', () => {
    const result = parseRegistry(fixture('lane-dialect.sh'))

    it('reads every row', () => {
        expect(result.dialect).toBe('lane')
        expect(result.skipped).toEqual([])
        expect(result.siblings).toHaveLength(5)
    })

    it('records the exported var rather than deriving it from the slug', () => {
        // Slug, directory and remote are three different names here, and the var follows
        // none of them. Derivation would produce WEB_CLIENT_DIR and every consumer would
        // read an unset variable.
        const web = result.siblings.find((s) => s.slug === 'web-client')!
        expect(web.var).toBe('WEB_DIR')
        expect(web.dir).toBe('example-web')
        expect(web.remote).toBe('web-frontend')
    })

    it('reads both axes without inferring either', () => {
        for (const s of result.siblings) {
            expect(s.mount.from).toBe('read')
            expect(s.acquire.from).toBe('read')
        }
    })

    it('maps the lane vocabulary onto mounts', () => {
        const byslug = Object.fromEntries(result.siblings.map((s) => [s.slug, s.mount.value]))
        expect(byslug['api']).toBe('always')
        expect(byslug['dispatch']).toBe('profile:dispatch')
        expect(byslug['storefront']).toBe('host')
    })

    it('reports the gaps it cannot answer rather than inventing them', () => {
        const g = gaps(result.siblings)
        // Two host-lane rows in this dialect, and no dialect records why.
        expect(g.filter((x) => x.field === 'host_reason').map((x) => x.slug).sort()).toEqual([
            'mobile',
            'storefront',
        ])
    })

    it('refuses a host lane with no recorded reason', () => {
        expect(() => toConfig('lane-example', result.siblings)).toThrow(/host_reason/)
    })
})

describe('tier dialect', () => {
    const result = parseRegistry(fixture('tier-dialect.sh'))

    it('reads every row', () => {
        expect(result.dialect).toBe('tier')
        expect(result.skipped).toEqual([])
        expect(result.siblings).toHaveLength(8)
    })

    it('keeps a var that contradicts its slug', () => {
        // A `renderer` sibling exporting ENGINE_DIR is exactly why the name is recorded and
        // never derived.
        expect(result.siblings.find((s) => s.slug === 'renderer')!.var).toBe('ENGINE_DIR')
    })

    it('gives a non-repo row no remote', () => {
        const local = result.siblings.find((s) => s.slug === 'local-dumps')!
        expect(local.acquire.value).toBe('none')
        expect(local.remote).toBeUndefined()
        expect(local.branch).toBeUndefined()
    })

    it('marks every mount inferred, because the dialect cannot state one', () => {
        for (const s of result.siblings) {
            expect(s.mount.from).toBe('inferred')
            expect(s.mount.because).toBeTruthy()
        }
    })

    it('recovers the profile lane from the purpose prose', () => {
        expect(result.siblings.find((s) => s.slug === 'booking')!.mount.value).toBe('profile:booking')
    })

    it('recovers a host lane from a make target, and mounts nothing without either signal', () => {
        const byslug = Object.fromEntries(result.siblings.map((s) => [s.slug, s.mount.value]))
        expect(byslug['docs']).toBe('host')
        expect(byslug['infra']).toBe('none')
    })

    it('maps tiers onto acquisition', () => {
        const byslug = Object.fromEntries(result.siblings.map((s) => [s.slug, s.acquire.value]))
        expect(byslug['app']).toBe('auto')
        expect(byslug['booking']).toBe('manual')
        expect(byslug['local-dumps']).toBe('none')
    })
})

describe('refusals', () => {
    it('does not silently drop a malformed row', () => {
        const src = 'X_SIBLINGS=(\n  "a|b|c"\n  "d|e|f|app|D_DIR|why"\n)\n'
        const r = parseRegistry(src)
        expect(r.siblings).toHaveLength(1)
        expect(r.skipped).toHaveLength(1)
        expect(r.skipped[0].reason).toMatch(/3 fields/)
    })

    it.each([
        ['a remote on a row that is never cloned', [{ slug: 'a', dir: 'a', remote: 'a', mount: 'none', acquire: 'none', var: 'A_DIR', purpose: 'p' }], /ever cloned/],
        ['a row that must be cloned but names no remote', [{ slug: 'a', dir: 'a', mount: 'always', acquire: 'auto', var: 'A_DIR', purpose: 'p' }], /needs a `remote`/],
        ['two siblings sharing an exported var', [
            { slug: 'a', dir: 'a', remote: 'a', mount: 'always', acquire: 'auto', var: 'SAME_DIR', purpose: 'p' },
            { slug: 'b', dir: 'b', remote: 'b', mount: 'always', acquire: 'auto', var: 'SAME_DIR', purpose: 'p' },
        ], /duplicate var/],
    ])('rejects %s', (_case, sibling, reason) => {
        expect(() => CockpitConfig.parse({ cockpit: { name: 'x' }, sibling, ports: { bases: { P: 80 } } })).toThrow(reason)
    })

    it('accepts a profile lane before the resolved profile set is supplied', () => {
        // The resolved profile set is external input to mounted(), so its absence from
        // CockpitConfig is normal. A profile lane cannot be rejected while parsing config.
        expect(() =>
            CockpitConfig.parse({
                cockpit: { name: 'x' },
                sibling: [{ slug: 'a', dir: 'a', remote: 'a', mount: 'profile:extra', acquire: 'auto', var: 'A_DIR', purpose: 'p' }],
                ports: { bases: { P: 80 } },
            }),
        ).not.toThrow()
    })
})

describe('fails closed', () => {
    it('accepts a closing comment but refuses executable syntax after the array', () => {
        const source = 'X_SIBLINGS=(\n  "a|a|a|app|A_DIR|purpose"\n)'
        const commented = parseRegistry(`${source} # repository inventory\n`)
        expect(commented.skipped).toEqual([])
        expect(commented.siblings.map((sibling) => sibling.slug)).toEqual(['a'])

        const executable = parseRegistry(`${source}; touch marker\n`)
        expect(executable.skipped.length).toBeGreaterThan(0)
        expect(executable.siblings).toEqual([])
    })

    // These are the cases that used to return `{dialect:'lane', siblings:[], skipped:[]}` —
    // a clean success over a file the parser had not understood at all.
    it('reports no dialect when there is no registry to read', () => {
        const r = parseRegistry('# just a comment\nexport FOO=bar\n')
        expect(r.dialect).toBeNull()
        expect(r.siblings).toEqual([])
        expect(r.skipped).toEqual([])
    })

    it('distinguishes an empty declared registry from an absent registry', () => {
        const absent = parseRegistry('# no registry\n')
        const declaredEmpty = parseRegistry('X_SIBLINGS=(\n)\n')

        expect(absent.found).toBe(false)
        expect(declaredEmpty.found).toBe(true)
        expect(declaredEmpty.dialect).toBeNull()
        expect(declaredEmpty.siblings).toEqual([])
        expect(declaredEmpty.skipped).toEqual([])
    })

    it('refuses an unterminated registry instead of publishing its rows', () => {
        const result = parseRegistry('X_SIBLINGS=(\n  "a|a|a|app|A_DIR|purpose"\n')

        expect(result.found).toBe(true)
        expect(result.dialect).toBeNull()
        expect(result.siblings).toEqual([])
        expect(result.skipped).toEqual([
            { sourceLine: 1, reason: 'unterminated sibling registry array' },
        ])
    })

    it('refuses a second sibling registry instead of publishing a partial inventory', () => {
        const result = parseRegistry([
            'FIRST_SIBLINGS=(',
            '  "first|first|first|app|FIRST_DIR|purpose"',
            ')',
            'SECOND_SIBLINGS=(',
            '  "second|second|second|app|SECOND_DIR|purpose"',
            ')',
        ].join('\n'))

        expect(result.dialect).toBeNull()
        expect(result.siblings).toEqual([])
        expect(result.skipped).toContainEqual({
            sourceLine: 4,
            code: 'REGISTRY_AMBIGUOUS',
            reason: 'multiple sibling registry arrays are ambiguous',
        })
    })

    it.each([
        '$PURPOSE',
        '${PURPOSE}',
        '$(printf purpose)',
        'purpose with \\"quoted\\" text',
    ])('refuses unsupported shell evaluation in a row: %s', (purpose) => {
        const result = parseRegistry(`X_SIBLINGS=(\n  "a|a|a|app|A_DIR|${purpose}"\n)\n`)

        expect(result.siblings).toEqual([])
        expect(result.skipped).toEqual([
            {
                sourceLine: 2,
                reason: 'unsupported shell expansion, substitution, or escape in double-quoted row',
            },
        ])
    })

    it.each([
        ['empty slug', '|dir|remote|app|SIBLING_DIR|purpose', /invalid slug/],
        ['invalid slug', 'Bad_Slug|dir|remote|app|SIBLING_DIR|purpose', /invalid slug/],
        ['empty directory', 'slug||remote|app|SIBLING_DIR|purpose', /invalid dir/],
        ['empty remote', 'slug|dir||app|SIBLING_DIR|purpose', /needs a `remote`/],
        ['invalid exported variable', 'slug|dir|remote|app|bad-var|purpose', /invalid var/],
        ['empty purpose', 'slug|dir|remote|app|SIBLING_DIR|', /invalid purpose/],
        ['remote on a local row', 'slug|dir|remote|main|local|SIBLING_DIR|purpose', /remove `remote`/],
        ['missing remote on an acquired row', 'slug|dir|-|main|auto|SIBLING_DIR|purpose', /needs a `remote`/],
    ])('suppresses a source row with %s', (_name, row, reason) => {
        const result = parseRegistry(`X_SIBLINGS=(\n  "${row}"\n)\n`)

        expect(result.siblings).toEqual([])
        expect(result.skipped).toHaveLength(1)
        expect(result.skipped[0]).toMatchObject({ sourceLine: 2 })
        expect(result.skipped[0].reason).toMatch(reason)
    })

    it.each([
        [
            'slug',
            'first|first-dir|first-remote|app|FIRST_DIR|purpose',
            'first|second-dir|second-remote|app|SECOND_DIR|purpose',
        ],
        [
            'dir',
            'first|shared-dir|first-remote|app|FIRST_DIR|purpose',
            'second|shared-dir|second-remote|app|SECOND_DIR|purpose',
        ],
        [
            'var',
            'first|first-dir|first-remote|app|SHARED_DIR|purpose',
            'second|second-dir|second-remote|app|SHARED_DIR|purpose',
        ],
    ])('reports and suppresses a duplicate %s', (field, first, second) => {
        const result = parseRegistry(`X_SIBLINGS=(\n  "${first}"\n  "${second}"\n)\n`)

        expect(result.siblings.map((s) => s.slug)).toEqual(['first'])
        expect(result.skipped).toEqual([
            {
                sourceLine: 3,
                reason: `duplicate ${field}; first declared on source line 2`,
            },
        ])
    })

    it('accepts one valid row at each exact dialect width', () => {
        const lane = parseRegistry('X_SIBLINGS=(\n  "a|a|a|app|A_DIR|purpose"\n)\n')
        const tier = parseRegistry('X_SIBLINGS=(\n  "b|b|b|main|auto|B_DIR|purpose"\n)\n')

        expect(lane.dialect).toBe('lane')
        expect(lane.siblings.map((s) => s.slug)).toEqual(['a'])
        expect(tier.dialect).toBe('tier')
        expect(tier.siblings.map((s) => s.slug)).toEqual(['b'])
    })

    it('skips rows immediately outside both exact dialect widths with safe source lines', () => {
        const r = parseRegistry([
            'X_SIBLINGS=(',
            '  "five|has|only|five|fields"',
            '  "lane|lane|lane|app|LANE_DIR|purpose"',
            '  "eight|has|eight|whole|fields|in|this|row"',
            ')',
            '',
        ].join('\n'))

        expect(r.dialect).toBe('lane')
        expect(r.siblings.map((s) => s.slug)).toEqual(['lane'])
        expect(r.skipped).toEqual([
            { sourceLine: 2, reason: '5 fields; expected 6 (lane) or 7 (tier)' },
            { sourceLine: 4, reason: '8 fields; expected 6 (lane) or 7 (tier)' },
        ])
        expect(r.skipped.every((row) => !('line' in row))).toBe(true)
    })

    it('uses only a strict width majority and preserves the winning row order', () => {
        const r = parseRegistry([
            'X_SIBLINGS=(',
            '  "first|first|first|app|FIRST_DIR|same purpose"',
            '  "minority|minority|minority|main|auto|MINORITY_DIR|same purpose"',
            '  "second|second|second|app|SECOND_DIR|same purpose"',
            ')',
            '',
        ].join('\n'))

        expect(r.dialect).toBe('lane')
        expect(r.siblings.map((s) => [s.slug, s.mount.value, s.acquire.value])).toEqual([
            ['first', 'always', 'auto'],
            ['second', 'always', 'auto'],
        ])
        expect(r.skipped).toEqual([
            { sourceLine: 3, reason: '7 fields in a 6-field registry' },
        ])
    })

    it('finds a registry behind ordinary bash decoration', () => {
        for (const opening of [
            'declare -a EXAMPLE_SIBLINGS=(',
            'readonly EXAMPLE_SIBLINGS=(',
            'EXAMPLE_SIBLINGS=( # the registry',
            'ACME2_SIBLINGS=(',
        ]) {
            const r = parseRegistry(`${opening}\n  "a|b|c|app|A_DIR|p"\n)\n`)
            expect(r.dialect, opening).toBe('lane')
            expect(r.siblings, opening).toHaveLength(1)
        }
    })

    it('refuses an ambiguous registry rather than discarding half of it', () => {
        const r = parseRegistry(
            'X_SIBLINGS=(\n  "a|b|c|app|A_DIR|p"\n  "d|e|f|main|auto|D_DIR|p"\n)\n',
        )
        expect(r.dialect).toBeNull()
        expect(r.siblings).toEqual([])
        expect(r.skipped.map((s) => s.sourceLine)).toEqual([2, 3])
        expect(r.skipped.every((s) => s.code === 'REGISTRY_AMBIGUOUS')).toBe(true)
        expect(r.skipped.some((s) => /no majority dialect/.test(s.reason))).toBe(true)
    })

    it('names every unusable line in the broken control fixture', () => {
        const r = parseRegistry(fixture('malformed.sh'))
        expect(r.siblings).toEqual([])
        const reasons = r.skipped.map((s) => s.reason).join(' | ')
        expect(reasons).toMatch(/3 fields/)
        expect(reasons).toMatch(/unknown lane "nonsense-lane"/)
        expect(reasons).toMatch(/not a double-quoted row/)
        // Four distinct defects, and the clean fixtures above stay green in the same run.
        expect(r.skipped.length).toBeGreaterThanOrEqual(4)
    })

    it('accepts only the exact profile lane grammar', () => {
        const valid = parseRegistry('X_SIBLINGS=(\n  "ok|ok|ok|profile:web-2|OK_DIR|purpose"\n)\n')
        expect(valid.siblings[0].mount.value).toBe('profile:web-2')

        for (const lane of ['profile:', 'profile:../web', 'profile:web/path', 'prof1le:web']) {
            const result = parseRegistry(`X_SIBLINGS=(\n  "bad|bad|bad|${lane}|BAD_DIR|purpose"\n)\n`)
            expect(result.siblings, lane).toEqual([])
            expect(result.skipped[0].reason, lane).toMatch(/unknown lane/)
        }
    })

    it('accurately describes unsupported single-quoted rows', () => {
        const result = parseRegistry("X_SIBLINGS=(\n  'a|a|a|app|A_DIR|purpose'\n)\n")

        expect(result.skipped[0].reason).toBe('not a double-quoted row; single-quoted rows are valid Bash but unsupported')
    })

    it('reports an unknown tier against the field that is actually wrong', () => {
        const r = parseRegistry('X_SIBLINGS=(\n  "a|b|c|main|requred|A_DIR|p"\n)\n')
        expect(r.siblings).toEqual([])
        expect(r.skipped[0].reason).toMatch(/unknown tier "requred"/)
    })

    it('does not infer a host lane from the word make in ordinary prose', () => {
        const r = parseRegistry(
            'X_SIBLINGS=(\n  "a|b|c|main|auto|A_DIR|utilities to make sure the fixtures stay in sync"\n)\n',
        )
        expect(r.siblings[0].mount.value).toBe('none')
    })

    it.each(['NO_EXTRA_PROFILES=web', 'SOME_EXTRA_PROFILES=web'])(
        'does not infer a profile from an unrelated assignment: %s',
        (assignment) => {
            const result = parseRegistry(
                `X_SIBLINGS=(\n  "a|a|a|main|auto|A_DIR|${assignment} is documented here"\n)\n`,
            )

            expect(result.siblings[0].mount.value).toBe('none')
        },
    )

    it('refuses conflicting standalone profile assignments', () => {
        const result = parseRegistry(
            'X_SIBLINGS=(\n  "a|a|a|main|auto|A_DIR|EXTRA_PROFILES=web or EXTRA_PROFILES=api"\n)\n',
        )

        expect(result.siblings).toEqual([])
        expect(result.skipped[0]).toEqual({
            sourceLine: 2,
            reason: 'ambiguous purpose; multiple EXTRA_PROFILES assignments',
            code: 'REGISTRY_AMBIGUOUS',
        })
    })

    it.each(['web,api', 'web:api', 'web+api'])(
        'refuses the complete multi-valued EXTRA_PROFILES assignment: %s',
        (profiles) => {
            const result = parseRegistry(
                `X_SIBLINGS=(\n  "a|a|a|main|auto|A_DIR|EXTRA_PROFILES=${profiles} make run"\n)\n`,
            )

            expect(result.siblings).toEqual([])
            expect(result.skipped).toEqual([
                {
                    sourceLine: 2,
                    reason: 'ambiguous purpose; EXTRA_PROFILES assignment does not name exactly one profile',
                    code: 'REGISTRY_AMBIGUOUS',
                },
            ])
        },
    )
})

describe('round trip through cockpit.toml', () => {
    // The public contract is registry text -> TOML text -> parsed config. Asserting
    // `not.toThrow()` on the in-memory object proves the parser agrees with itself.
    for (const [name, file, answers, operatorGates] of [
        ['lane', 'lane-dialect.sh', { mobile: 'simulator cannot be containerised', storefront: 'renderer is the vendor cloud' }, ['mobile', 'storefront']],
        ['tier', 'tier-dialect.sh', { docs: 'pinned interpreter outside the stack', renderer: 'pinned interpreter outside the stack' }, ['docs', 'renderer', 'local-dumps']],
    ] as const) {
        it(`${name} dialect survives emit and re-parse unchanged`, () => {
            const parsed = parseRegistry(fixture(file))
            const config = toConfig(`${name}-example`, parsed.siblings, answers, operatorGates)
            const reparsed = CockpitConfig.parse(parseToml(emitToml(config)))
            expect(reparsed).toEqual(config)
            // and the values actually survived, not merely the shape
            expect(reparsed.sibling.map((s) => [s.slug, s.var, s.mount, s.acquire])).toEqual(
                config.sibling.map((s) => [s.slug, s.var, s.mount, s.acquire]),
            )
        })
    }
})

describe('gaps', () => {
    it('does not ask for a toolchain on a row that is not a repository', () => {
        const r = parseRegistry(fixture('tier-dialect.sh'))
        const asked = gaps(r.siblings).filter((g) => g.field === 'toolchain').map((g) => g.slug)
        expect(asked).not.toContain('local-dumps')
    })

    it('marks a gap the schema will refuse as blocking', () => {
        const r = parseRegistry(fixture('lane-dialect.sh'))
        const g = gaps(r.siblings)
        expect(g.filter((x) => x.field === 'host_reason').every((x) => x.blocking)).toBe(true)
        expect(g.filter((x) => x.field === 'gate').every((x) => x.blocking)).toBe(true)
        expect(g.filter((x) => x.field === 'toolchain').every((x) => !x.blocking)).toBe(true)
    })

    it.each([
        ['host mount', 'ordinary host task', 'host'],
        ['live purpose', 'talks to a live service', 'none'],
        ['production purpose', 'PRODUCTION maintenance', 'none'],
        ['hardware purpose', 'local hardware runner', 'none'],
        ['simulator purpose', 'starts a simulator', 'none'],
    ] as const)('requires an actionable operator gate for a %s', (_case, purpose, mount) => {
        const sibling: DocumentedSibling = {
            slug: 'runner',
            dir: 'runner',
            remote: 'runner',
            mount: { value: mount, from: 'read' },
            acquire: { value: 'auto', from: 'read' },
            var: 'RUNNER_DIR',
            purpose,
        }

        expect(gaps([sibling])).toContainEqual({
            slug: 'runner',
            field: 'gate',
            why: 'this lane can touch live data or local hardware and must require an operator',
            blocking: true,
            fix: 'set gate = "operator" before running this lane',
        })
    })
})

describe('mounted()', () => {
    const cfg = () =>
        CockpitConfig.parse({
            cockpit: { name: 'x' },
            ports: { bases: { P: 80 } },
            sibling: [
                { slug: 'a', dir: 'a', remote: 'a', mount: 'always', acquire: 'auto', var: 'A_DIR', purpose: 'p' },
                { slug: 'b', dir: 'b', remote: 'b', mount: 'profile:extra', acquire: 'auto', var: 'B_DIR', purpose: 'p' },
                { slug: 'c', dir: 'c', remote: 'c', mount: 'host', acquire: 'auto', var: 'C_DIR', purpose: 'p', host_reason: 'r', gate: 'operator' },
            ],
        })

    it('binds always-mounted rows and leaves host lanes out', () => {
        expect(mounted(cfg(), []).map((s) => s.slug)).toEqual(['a'])
    })

    it('binds a profile row only when its profile is on', () => {
        expect(mounted(cfg(), ['extra']).map((s) => s.slug)).toEqual(['a', 'b'])
    })
})

describe('guide projection', () => {
    it('defaults to the two conventional guide filenames', () => {
        const cfg = CockpitConfig.parse({
            cockpit: { name: 'x' },
            ports: { bases: { P: 80 } },
            sibling: [{ slug: 'a', dir: 'a', remote: 'a', mount: 'always', acquire: 'auto', var: 'A_DIR', purpose: 'p' }],
        })
        expect(cfg.sibling[0].guides).toEqual(['CLAUDE.md', 'AGENTS.md'])
    })

    it('lets a repository declare guides it actually publishes', () => {
        const cfg = CockpitConfig.parse({
            cockpit: { name: 'x' },
            ports: { bases: { P: 80 } },
            sibling: [{ slug: 'a', dir: 'a', remote: 'a', mount: 'always', acquire: 'auto', var: 'A_DIR', purpose: 'p', guides: ['CONVENTIONS.md'] }],
        })
        expect(cfg.sibling[0].guides).toEqual(['CONVENTIONS.md'])
    })

    it('refuses an empty guide filename rather than projecting a link to nowhere', () => {
        expect(() =>
            CockpitConfig.parse({
                cockpit: { name: 'x' },
                ports: { bases: { P: 80 } },
                sibling: [{ slug: 'a', dir: 'a', remote: 'a', mount: 'always', acquire: 'auto', var: 'A_DIR', purpose: 'p', guides: [''] }],
            }),
        ).toThrow()
    })
})
