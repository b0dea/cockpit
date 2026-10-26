import { requiresOperatorGate, type Acquire, type Mount } from '../schema.js'

export const mechanism = {
    id: 'registry-parsing',
    module: 'packages/cockpit/src/document/registry.ts',
    exports: ['parseRegistry', 'gaps'],
} as const

// `document` reads a cockpit that already exists and writes down what it already is. It
// never guesses silently: every field it could not read directly carries a Provenance, and
// `cockpit document` prints the inferred ones for a human to confirm once. A clean-looking
// config with invented values in it is worse than a gap, because the next reader budgets for
// a fact that was never established.
export type Provenance = 'read' | 'inferred'

export interface Field<T> {
    value: T
    from: Provenance
    /** Why, when inferred. Printed next to the value; empty when read directly. */
    because?: string
}

export interface DocumentedSibling {
    slug: string
    dir: string
    remote?: string
    branch?: string
    mount: Field<Mount>
    acquire: Field<Acquire>
    var: string
    purpose: string
}

export interface RegistryReadResult {
    /** Whether a sibling array declaration was present, including a declared empty array. */
    found: boolean
    /**
     * Which dialect the usable rows were written in, or `null` when no dialect was established.
     *
     * Never defaulted. An earlier version returned `'lane'` for a file with no registry in
     * it, which meant a caller could not tell "this file has no registry" from "this
     * registry is empty" from "I did not recognise the opening line" — and `document` would
     * report success over a config with no siblings. The field a reader trusts most is the
     * last one that may be invented.
     */
    dialect: 'lane' | 'tier' | null
    siblings: DocumentedSibling[]
    /** Rows the parser saw but could not use, identified without exposing their contents. */
    skipped: {
        sourceLine: number
        reason: string
        code?: 'REGISTRY_AMBIGUOUS'
    }[]
}

type RegistryRowFailure = {
    reason: string
    code?: RegistryReadResult['skipped'][number]['code']
}

// Deliberately wider than the two registries in hand: a `declare -a`/`readonly` prefix, a
// digit in the array name, and a trailing comment are all ordinary bash that the first
// version silently failed to recognise — and failing to recognise the opening line produced
// a clean empty success, which is the worst outcome this module can return.
const ARRAY_RE = /^\s*(?:(?:declare|readonly|local|export)\s+(?:-\w+\s+)?)?[A-Z][A-Z0-9_]*_SIBLINGS=\(\s*(?:#.*)?$/
const ROW_RE = /^\s*"([^"]+)"\s*(?:#.*)?$/
const IGNORABLE_RE = /^\s*(?:#.*)?$/

// The vocabularies are closed. A word outside them is reported, never mapped to a default:
// `mount: 'none'` means "the stack never binds this", so quietly choosing it for an
// unrecognised lane removes a repository from every bring-up — and the old code then stamped
// that invented value `from: 'read'`, which is the exact inversion of this module's contract.
const LANE_MOUNT: Record<string, Mount> = { app: 'always', host: 'host' }
const TIER_ACQUIRE: Record<string, Acquire> = { required: 'auto', auto: 'auto', manual: 'manual', local: 'none' }

/**
 * Parse a `*_SIBLINGS=( "a|b|c" ... )` block out of an `env/lib/instance.sh`.
 *
 * The dialect is decided by field count, the one signal that is unambiguous. The lane
 * dialect writes six fields (`slug|dir|remote|lane|var|purpose`); the tier dialect writes
 * seven, adding `branch` and replacing the fourth-position `lane` with a fifth-position
 * `tier`. A row of any other width is recorded as skipped rather than bent into shape.
 */
export function parseRegistry(source: string): RegistryReadResult {
    const lines = source.split('\n')
    const rows: { line: string; sourceLine: number }[] = []
    const unparsed: { sourceLine: number; reason: string }[] = []
    let inside = false
    let found = false
    let openingLine: number | undefined
    let declarationCount = 0
    let duplicateOpeningLine: number | undefined

    for (const [index, line] of lines.entries()) {
        if (!inside) {
            if (ARRAY_RE.test(line)) {
                inside = true
                found = true
                openingLine = index + 1
                declarationCount += 1
                if (declarationCount === 2) duplicateOpeningLine = index + 1
            }
            continue
        }
        if (/^\s*\)\s*(?:#.*)?$/.test(line)) {
            inside = false
            continue
        }
        const m = ROW_RE.exec(line)
        if (m && !/[$`\\]/.test(m[1])) rows.push({ line: m[1], sourceLine: index + 1 })
        else if (!IGNORABLE_RE.test(line)) {
            const unsupportedShellSyntax = /^\s*"/.test(line) && /[$`\\]/.test(line)
            unparsed.push({
                sourceLine: index + 1,
                reason: unsupportedShellSyntax
                    ? 'unsupported shell expansion, substitution, or escape in double-quoted row'
                    : 'not a double-quoted row; single-quoted rows are valid Bash but unsupported',
            })
        }
    }

    const skipped: RegistryReadResult['skipped'] = []
    skipped.push(...unparsed)
    if (inside) {
        skipped.push({ sourceLine: openingLine!, reason: 'unterminated sibling registry array' })
        return { found: true, dialect: null, siblings: [], skipped }
    }
    if (duplicateOpeningLine !== undefined) {
        skipped.push({
            sourceLine: duplicateOpeningLine,
            reason: 'multiple sibling registry arrays are ambiguous',
            code: 'REGISTRY_AMBIGUOUS',
        })
        return { found: true, dialect: null, siblings: [], skipped }
    }
    const parsed: { fields: string[]; sourceLine: number }[] = []
    for (const { line, sourceLine } of rows) {
        const fields = line.split('|')
        if (fields.length === 6 || fields.length === 7) parsed.push({ fields, sourceLine })
        else skipped.push({ sourceLine, reason: `${fields.length} fields; expected 6 (lane) or 7 (tier)` })
    }

    // No opening line at all is a different fact from an empty registry, and both are
    // different from "every row was malformed". `found` preserves that distinction while
    // `dialect` remains null until at least one usable row establishes a width.
    if (!found) return { found: false, dialect: null, siblings: [], skipped }
    if (parsed.length === 0) return { found: true, dialect: null, siblings: [], skipped }

    // A registry is written in one dialect. Mixed widths mean the file was hand-edited into
    // an inconsistent state, and the minority rows are reported rather than reinterpreted.
    // Plain mode over the widths. A tie is NOT resolved by picking one: with equal counts
    // there is no minority, and silently discarding half the registry into `skipped` is the
    // fail-open this module exists to prevent.
    const counts = new Map<number, number>()
    for (const { fields } of parsed) counts.set(fields.length, (counts.get(fields.length) ?? 0) + 1)
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
        for (const { sourceLine } of parsed) {
            skipped.push({
                sourceLine,
                reason: `ambiguous registry: ${ranked[0][1]} rows of ${ranked[0][0]} fields and ${ranked[1][1]} of ${ranked[1][0]} — no majority dialect`,
                code: 'REGISTRY_AMBIGUOUS',
            })
        }
        return { found: true, dialect: null, siblings: [], skipped }
    }
    const dialectWidth = ranked[0][0]
    const dialect = dialectWidth === 7 ? 'tier' : 'lane'

    const siblings: DocumentedSibling[] = []
    const seen = {
        slug: new Map<string, number>(),
        dir: new Map<string, number>(),
        var: new Map<string, number>(),
    }
    for (const { fields, sourceLine } of parsed) {
        if (fields.length !== dialectWidth) {
            skipped.push({ sourceLine, reason: `${fields.length} fields in a ${dialectWidth}-field registry` })
            continue
        }
        const row = dialect === 'lane' ? fromLane(fields) : fromTier(fields)
        if ('reason' in row) skipped.push({ sourceLine, ...row })
        else {
            const reason = sourceValidationReason(row)
            if (reason) skipped.push({ sourceLine, reason })
            else {
                const duplicate = (['slug', 'dir', 'var'] as const)
                    .map((field) => ({ field, firstLine: seen[field].get(row[field]) }))
                    .find(({ firstLine }) => firstLine !== undefined)
                if (duplicate) {
                    skipped.push({
                        sourceLine,
                        reason: `duplicate ${duplicate.field}; first declared on source line ${duplicate.firstLine}`,
                    })
                    continue
                }

                siblings.push(row)
                for (const field of ['slug', 'dir', 'var'] as const) seen[field].set(row[field], sourceLine)
            }
        }
    }

    return { found: true, dialect, siblings, skipped }
}

function sourceValidationReason(row: DocumentedSibling): string | undefined {
    if (row.acquire.value === 'none' && row.remote !== undefined) {
        return 'acquire "none" means nothing is ever cloned — remove `remote`'
    }
    if (row.acquire.value !== 'none' && !row.remote) {
        return 'acquire "auto" or "manual" needs a `remote` to clone from'
    }

    if (!/^[a-z0-9][a-z0-9-]*$/.test(row.slug)) {
        return 'invalid slug; expected lowercase letters, digits, and hyphens'
    }
    if (!row.dir) return 'invalid dir; expected a non-empty value'
    if (row.branch !== undefined && !row.branch) return 'invalid branch; expected a non-empty value'
    if (!/^[A-Z][A-Z0-9_]*$/.test(row.var)) {
        return 'invalid var; expected an exported shell variable name'
    }
    if (!row.purpose) return 'invalid purpose; expected a non-empty value'
    return undefined
}

/** Lane dialect: `slug|dir|remote|lane|var|purpose`. Both axes read without inference. */
function fromLane(f: string[]): DocumentedSibling | RegistryRowFailure {
    const [slug, dir, remote, lane, varName, purpose] = f.map((s) => s.trim())
    const mount: Mount | undefined = /^profile:[a-z0-9-]+$/.test(lane) ? (lane as Mount) : LANE_MOUNT[lane]
    if (!mount) return { reason: `unknown lane "${lane}" — expected app, host or profile:<name>` }
    return {
        slug,
        dir,
        remote,
        mount: { value: mount, from: 'read' },
        // Every row in a lane-dialect registry is cloned by setup from its recorded remote;
        // the dialect has no way to say otherwise, so this is the dialect's meaning, not a guess.
        acquire: { value: 'auto', from: 'read' },
        var: varName,
        purpose,
    }
}

/**
 * Tier dialect: `slug|dir|remote|branch|tier|var|purpose`.
 *
 * `acquire` maps straight off `tier`. `mount` does not exist in this dialect and must be
 * inferred — a tier says how a checkout arrives, never whether the stack binds it. The
 * purpose column carries the answer in practice, because a registry that cannot state the
 * mount tends to write the activating command into the prose instead
 * (`EXTRA_PROFILES=<name> …`, `make <target> — …`). That is a real signal, but it is prose,
 * so every value here is marked inferred and printed for confirmation.
 */
function fromTier(f: string[]): DocumentedSibling | RegistryRowFailure {
    const [slug, dir, remote, branch, tier, varName, purpose] = f.map((s) => s.trim())

    const acquire = TIER_ACQUIRE[tier]
    // Without this the old code mapped a typo to `none`, retained the remote, and the schema
    // then rejected the row naming `remote` — sending the operator to fix the wrong field.
    if (!acquire) return { reason: `unknown tier "${tier}" — expected required, auto, manual or local` }

    const assignments = [...purpose.matchAll(/(?:^|[\s;(])EXTRA_PROFILES=([^\s;)]*)/gi)].map(
        (match) => match[1].toLowerCase(),
    )
    if (assignments.some((assignment) => !/^[a-z0-9-]+$/.test(assignment))) {
        return {
            reason: 'ambiguous purpose; EXTRA_PROFILES assignment does not name exactly one profile',
            code: 'REGISTRY_AMBIGUOUS',
        }
    }
    const profiles = assignments
    const uniqueProfiles = [...new Set(profiles)]
    if (uniqueProfiles.length > 1) {
        return {
            reason: 'ambiguous purpose; multiple EXTRA_PROFILES assignments',
            code: 'REGISTRY_AMBIGUOUS',
        }
    }

    let mount: Field<Mount>
    const profile = uniqueProfiles[0]
    // Anchored: an unanchored \bmake\b matched ordinary English ("utilities to make sure
    // the fixtures stay in sync" inferred a host lane on target "sure"), and a false host
    // lane removes a repository from every bring-up.
    const makeTarget = /^make\s+([a-z0-9-]+)\b/.exec(purpose)
    if (tier === 'required') {
        mount = { value: 'always', from: 'inferred', because: 'tier "required" — the stack bind-mounts it or preflight fails' }
    } else if (profile) {
        mount = { value: `profile:${profile}` as Mount, from: 'inferred', because: `purpose names EXTRA_PROFILES=${profile}` }
    } else if (makeTarget) {
        mount = { value: 'host', from: 'inferred', because: `purpose opens with \`make ${makeTarget[1]}\` — a target, never a compose service` }
    } else {
        mount = { value: 'none', from: 'inferred', because: 'no profile and no make target in purpose — read, never mounted' }
    }

    return {
        slug,
        dir,
        remote: remote === '-' ? undefined : remote,
        branch: branch === '-' ? undefined : branch,
        mount,
        acquire: { value: acquire, from: tier === 'required' ? 'inferred' : 'read', because: tier === 'required' ? 'tier "required" implies setup clones it' : undefined },
        var: varName,
        purpose,
    }
}

/** A field the schema requires that no source registry can supply. A human fills it once. */
export interface Gap {
    slug: string
    field: string
    why: string
    /** True when the schema refuses the config until this is answered. */
    blocking: boolean
    /** Action specific to the source of the gap, when the generic fix would mislead. */
    fix?: string
}

/**
 * Fields `document` cannot answer from any existing registry.
 *
 * This is deliberately not solved by writing a plausible value. A host lane's reason — a
 * simulator that cannot be containerised, a renderer that lives in a vendor's cloud — is a
 * constraint someone discovered, and a generated guess at it is worse than a blank, because
 * the next reader treats it as established. So `document` produces a config that is
 * incomplete *and says which parts*, and the operator answers once.
 */
export function gaps(siblings: DocumentedSibling[]): Gap[] {
    const out: Gap[] = []
    for (const s of siblings) {
        if (s.mount.value === 'host') {
            out.push({
                slug: s.slug,
                field: 'host_reason',
                why: 'no registry dialect records why a repository cannot join the stack',
                blocking: true,
            })
        }
        // A lane touching live data or local hardware must never run automatically, and no
        // dialect records that. Left unasked, `document` emits a config in which a lane that
        // renders against a live third-party store is an ordinary automatic target.
        if (requiresOperatorGate({ mount: s.mount.value, purpose: s.purpose })) {
            out.push({
                slug: s.slug,
                field: 'gate',
                why: 'this lane can touch live data or local hardware and must require an operator',
                blocking: true,
                fix: 'set gate = "operator" before running this lane',
            })
        }
        // Not asked for a row that is not a repository: it has no install step, and a gap
        // nobody can answer is noise that degrades the signal of the ones that matter.
        if (s.acquire.value !== 'none') {
            out.push({
                slug: s.slug,
                field: 'toolchain',
                why: 'not recorded by any registry dialect; defaults to "none" until confirmed',
                blocking: false,
            })
        }
    }
    return out
}
