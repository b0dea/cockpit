import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { diagnosticInventory, diagnosticInventoryFromSources, type DiagnosticInventory } from '../../../scripts/diagnostic-inventory.ts'
import { readReferenceSources, renderReferences, type ReferenceSources } from '../../../scripts/references.ts'
import { commands } from './command-table.js'
import { configurationDefaults } from './schema.js'
import { renderCockpitSchema } from './schema-json.js'

const ROOT = join(import.meta.dirname, '../../..')
const begin = '<!-- cockpit:diagnostic-index:begin -->'
const end = '<!-- cockpit:diagnostic-index:end -->'
const prose = `# Troubleshooting\r\n\r\nKeep this human paragraph.\r\n${begin}\nold index\n${end}\r\n\r\nKeep the suffix.\r\n`
const wholePaths = ['docs/cli-reference.md', 'docs/configuration-reference.md', 'docs/command-list.md', 'docs/capability-matrix.md', 'skills/adopt-cockpit/SKILL.md']
let shipped: ReferenceSources

beforeAll(async () => { shipped = await readReferenceSources(ROOT) })

function inventory(remedies: Record<string, DiagnosticInventory['remedies'] extends ReadonlyMap<string, infer R> ? R : never>): DiagnosticInventory {
    const codes = Object.keys(remedies).sort()
    return { codes, owners: new Map(codes.map(code => [code, new Set(['packages/cockpit/src/document/command.ts'])])), remedies: new Map(Object.entries(remedies)) }
}

function sources(overrides: Partial<ReferenceSources> = {}): ReferenceSources {
    return { ...shipped, troubleshooting: prose, diagnostics: inventory({ SYNTHETIC_FAILURE: { kind: 'fixed', fix: 'repair the synthetic input' } }), ...overrides }
}

async function pages(overrides: Partial<ReferenceSources> = {}) {
    return new Map((await renderReferences(sources(overrides))).map(file => [file.path, file.bytes]))
}

type SchemaNode = Readonly<Record<string, unknown>>
const isNode = (value: unknown): value is SchemaNode => value !== null && typeof value === 'object' && !Array.isArray(value)
const isTable = (value: unknown): boolean => isNode(value) && isNode(value.properties)

/**
 * Reads the configuration reference back against the schema it was rendered from, and returns
 * every schema property, constraint, rule and runtime check the page lost. It follows the page's
 * links, so a table rendered once as a shared shape is checked at every place that uses it.
 */
function configurationReferenceGaps(page: string, schema: SchemaNode): string[] {
    const anchor = (heading: string) => heading.trim().toLowerCase().replace(/[`*~]/g, '').replace(/[^a-z0-9 _-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
    const sections = new Map(page.split(/^#{2,3} /m).slice(1).map(part => [anchor(part.slice(0, part.indexOf('\n'))), part.slice(part.indexOf('\n') + 1)]))
    const cells = (line: string) => line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim().replaceAll('\\|', '|'))
    const rowsOf = (body: string) => body.split('\n').filter(line => line.startsWith('| `')).map(cells)
    const patterns = new Map((sections.get('patterns') ?? '').split('\n').filter(line => /^\| P\d+ \|/.test(line)).map(cells)
        .map(([name, regex]) => [regex!.slice(1, -1), name!]))
    const gaps: string[] = []
    const expectText = (text: string, needle: string, where: string, what: string) => { if (!text.includes(needle)) gaps.push(`${where}: ${what} ${needle} is missing`) }
    const expectNumber = (text: string, value: number, where: string, what: string) => {
        if (!new RegExp(`(?<![\\w.])${String(value).replace('.', '\\.')}(?![\\w.])`).test(text)) gaps.push(`${where}: ${what} ${value} is missing`)
    }
    const variants = (node: SchemaNode) => {
        const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : []
        return !isTable(node) && branches.length > 0 && branches.every(isTable) ? branches as SchemaNode[] : undefined
    }
    const facts = (node: SchemaNode, row: string, where: string) => {
        if (node.default !== undefined) expectText(row, JSON.stringify(node.default), where, 'default')
        if (typeof node.description === 'string') expectText(row, node.description, where, 'description')
        if (isTable(node) || variants(node)) return
        for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) {
            if (typeof node[key] === 'number') expectNumber(row, node[key] as number, where, key)
        }
        if (node.exclusiveMinimum === true) expectText(row, `greater than ${node.minimum}`, where, 'exclusiveMinimum')
        if (node.uniqueItems === true) expectText(row, 'unique items', where, 'uniqueItems')
        if (typeof node.format === 'string') expectText(row, `\`${node.format}\``, where, 'format')
        if (Array.isArray(node.enum)) for (const literal of node.enum) expectText(row, `\`${JSON.stringify(literal)}\``, where, 'enum value')
        if (typeof node.pattern === 'string' && !row.includes(`\`${node.pattern}\``)) {
            expectText(row, `[${patterns.get(node.pattern) ?? 'an inline or named pattern'}](#patterns)`, where, 'pattern')
        }
        if (node.not !== undefined) expectText(row, JSON.stringify(node.not), where, 'not')
        for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
            if (Array.isArray(node[keyword])) for (const branch of node[keyword] as SchemaNode[]) facts(branch, row, where)
        }
        if (isNode(node.items)) facts(node.items, row, `${where}[]`)
        if (isNode(node.additionalProperties)) facts(node.additionalProperties, row, `${where}.*`)
        if (isNode(node.patternProperties)) for (const [key, value] of Object.entries(node.patternProperties)) {
            if (!row.includes(`\`${key}\``)) expectText(row, `[${patterns.get(key) ?? 'an inline or named pattern'}](#patterns)`, where, 'key pattern')
            if (isNode(value)) facts(value, row, `${where}.*`)
        }
    }
    const table = (node: SchemaNode, id: string, where: string) => {
        const body = sections.get(id)
        if (body === undefined) { gaps.push(`${where}: no section #${id}`); return }
        for (const rule of Array.isArray(node.allOf) ? node.allOf : []) expectText(body, JSON.stringify(rule), where, 'allOf rule')
        for (const keyword of ['anyOf', 'oneOf', 'not']) if (node[keyword] !== undefined) expectText(body, JSON.stringify(node[keyword]), where, `${keyword} rule`)
        if (node.additionalProperties !== false) expectText(body, node.additionalProperties === undefined ? 'Accepts keys this table does not list'
            : JSON.stringify(node.additionalProperties), where, 'additionalProperties')
        const rows = rowsOf(body)
        const required = new Set(Array.isArray(node.required) ? node.required : [])
        for (const [key, child] of Object.entries(node.properties as SchemaNode)) {
            const path = where === '' ? key : `${where}.${key}`
            const matches = rows.filter(row => row[0] === `\`${key}\``)
            if (matches.length !== 1 || !isNode(child)) { gaps.push(`${path}: expected one row in #${id}, found ${matches.length}`); continue }
            const row = matches[0]!.join(' | ')
            if (required.has(key)) expectText(matches[0]![4]!, 'required', path, 'required')
            // The field's own sentence belongs in the Meaning cell, not folded into the constraints.
            if (typeof child.description === 'string' && matches[0]![1] !== child.description) gaps.push(`${path}: Meaning cell does not hold the description`)
            const nested = isTable(child) ? [child] : isTable(child.items) ? [child.items as SchemaNode] : variants(child) ?? (isNode(child.items) ? variants(child.items) : undefined) ?? []
            const links = [...matches[0]![2]!.matchAll(/\]\(#([^)]+)\)/g)].map(match => match[1]!)
            if (links.length !== nested.length) gaps.push(`${path}: links ${links.length} tables, expected ${nested.length}`)
            nested.forEach((branch, index) => table(branch, links[index] ?? '', path))
            facts(child, row, path)
        }
    }
    table(schema, 'top-level-keys', '')
    const checks = rowsOf(sections.get('checks-beyond-the-schema') ?? '')
    const editor = schema['x-cockpit-editor-limitations'] as readonly SchemaNode[]
    for (const check of schema['x-cockpit-runtime-checks'] as readonly SchemaNode[]) {
        const where = `${String(check.path)} ${String(check.rule)}`
        const row = checks.find(cells => cells[0] === `\`${String(check.path)}\`` && cells[1]!.startsWith(`\`${String(check.rule)}\``))
        if (!row) { gaps.push(`${where}: runtime check is missing`); continue }
        if (check.limit !== undefined) expectNumber(row[1]!, check.limit as number, where, 'limit')
        const limited = editor.some(entry => entry.path === check.path && entry.rule === check.rule)
        if ((row[2] === 'yes') !== limited) gaps.push(`${where}: editor limitation is ${limited ? 'unmarked' : 'marked wrongly'}`)
    }
    return gaps
}

describe('diagnostic inventory', () => {
    it('derives conditional and fallback diagnostic codes from production owners', () => {
        const found = diagnosticInventory(ROOT)
        const expectedOwners = new Map<string, readonly string[]>([
            ['DOCUMENT_DEFAULT', ['packages/cockpit/src/init/draft.ts']],
            ['DOCUMENT_INFERRED', ['packages/cockpit/src/init/draft.ts']],
            ['ADOPTION_STATE_INVALID', ['packages/cockpit/src/registry-resolve/command.ts']],
            ['ADOPTION_RECORD_INVALID', ['packages/cockpit/src/registry-resolve/command.ts']],
            ['REGISTRY_ENCODING_INVALID', ['packages/cockpit/src/init/draft.ts', 'packages/cockpit/src/registry-resolve/command.ts']],
            ['REGISTRY_ROW_SKIPPED', ['packages/cockpit/src/init/draft.ts', 'packages/cockpit/src/registry-resolve/command.ts']],
            ['SURFACE_OVERRIDE_INSPECTION_REFUSED', ['packages/cockpit/src/environment/health-composition.ts']],
            ['COCKPIT_VERSION_MISMATCH', ['packages/cockpit/src/environment/contract.ts', 'packages/cockpit/src/team-metadata.ts']],
        ])
        for (const [code, owners] of expectedOwners) expect([...found.owners.get(code) ?? []].sort(), code).toEqual([...owners].sort())
        expect(found.remedies.size).toBe(found.codes.length)
    })

    it('derives diagnostic unions from returned code parameters and ignores codes that are only mentioned', () => {
        const path = 'packages/cockpit/src/generated/vendor.ts'
        const found = diagnosticInventoryFromSources(new Map([[path, [
            "export type VendorCode = 'VENDOR_NOT_MEASURED' | 'VENDOR_NOT_AVAILABLE'",
            'function unmeasured(code: VendorCode) { return { state: "unavailable", code } }',
            'export function observeVendor(code: VendorCode) { return unmeasured(code) }',
            "const unrelated = 'SYNTHETIC_NOT_EMITTED' // SYNTHETIC_COMMENT_ONLY",
            'void unrelated',
            '',
        ].join('\n')]]))
        expect(found.codes).toEqual(['VENDOR_NOT_AVAILABLE', 'VENDOR_NOT_MEASURED'])
        expect([...found.owners.get('VENDOR_NOT_MEASURED') ?? []]).toEqual([path])
    })

    it('derives typed parser findings collected before the public result is returned', () => {
        const path = 'packages/cockpit/src/work-orders/parser.ts'
        const inventory = diagnosticInventoryFromSources(new Map([[path, [
            "export const PARSER_FINDING_CODES = Object.freeze(['WO_SIZE_LIMIT', 'WO_FRONTMATTER_INVALID'] as const)",
            'export type ParserFindingCode = typeof PARSER_FINDING_CODES[number]',
            'interface ParserFinding { readonly code: ParserFindingCode; readonly target: string; readonly message: string }',
            'function immutable<T>(value: T): T | undefined { return snapshotJson(value) as T | undefined }',
            'export function parseWorkOrder(input: string) {',
            '  const findings: ParserFinding[] = []',
            '  const add = (code: ParserFindingCode, target: string, message: string) => {',
            '    findings.push(Object.freeze({ code, target, message }))',
            '  }',
            "  if (input.length > 8) add('WO_SIZE_LIMIT', 'work-order', 'too large')",
            "  if (!input.startsWith('---')) add('WO_FRONTMATTER_INVALID', 'frontmatter', 'invalid')",
            '  return immutable({ ok: findings.length === 0, findings: Object.freeze(findings) })!',
            '}',
            'function usageOutcome(code: string, message: string) { return { status: 2, diagnostics: [{ code, message }] } }',
            "export const rejected = () => usageOutcome('WORK_APPLICATION_REFUSED', 'work refused')",
            "export const operator = () => usageOutcome('WORK_OPERATOR_REQUIRED', 'operator required')",
            'function writeOutput(existing: boolean) {',
            "  const diagnostic = existing ? { code: 'OUTPUT_EXISTS', message: 'exists' } : { code: 'OUTPUT_WRITE_FAILED', message: 'write failed' }",
            '  return { diagnostics: [diagnostic] }',
            '}',
            'function renderJsonResponse(value: unknown) { return JSON.stringify(value) }',
            'function guard() {',
            '  let response: unknown',
            "  response = { diagnostics: [{ code: 'GUARD_INPUT_UNAVAILABLE' }] }",
            '  renderJsonResponse({ diagnostics: response.diagnostics })',
            '}',
            'function document() {',
            '  const diagnostics: unknown[] = []',
            "  diagnostics.unshift({ code: 'DOCUMENT_STDOUT_TARGET' })",
            '  return { diagnostics }',
            '}',
            'function warnings() {',
            '  const warnings: unknown[] = []',
            "  warnings.push(Object.freeze({ code: 'SURFACE_GENERATOR_TRUST_WARNING' }))",
            '  return Object.freeze(warnings)',
            '}',
            'function collectMcp() {',
            '  const diagnostics: unknown[] = []',
            "  diagnostics.push({ code: 'MCP_APPROVAL_UNKNOWN' })",
            '  const outcome = snapshotJson({ diagnostics })',
            '  return outcome',
            '}',
            "function unrelatedTransform() { const value = transform({ code: 'DECOY_TRANSFORM_ARGUMENT' }); return value }",
            "function unrelatedMutation() { const warnings: unknown[] = []; warnings.push({ code: 'DECOY_UNRETURNED_ARRAY' }); return [] }",
            "function unrelatedRender() { renderOther({ code: 'DECOY_RENDER_ARGUMENT' }) }",
            "function unrelated() { const add = (value: string) => value; return add('DECOY_GENERIC_ADD') }",
            "const unrelatedObject = Object.freeze({ code: 'DECOY_NOT_RETURNED' })",
            '',
        ].join('\n')]]))
        expect(inventory.codes).toEqual([
            'DOCUMENT_STDOUT_TARGET', 'GUARD_INPUT_UNAVAILABLE', 'MCP_APPROVAL_UNKNOWN', 'OUTPUT_EXISTS', 'OUTPUT_WRITE_FAILED',
            'SURFACE_GENERATOR_TRUST_WARNING', 'WORK_APPLICATION_REFUSED', 'WORK_OPERATOR_REQUIRED', 'WO_FRONTMATTER_INVALID', 'WO_SIZE_LIMIT',
        ])
        for (const code of ['WO_SIZE_LIMIT', 'GUARD_INPUT_UNAVAILABLE']) expect([...inventory.owners.get(code) ?? []]).toEqual([path])
    })

    it('states a fix only when every place that raises the code states the same one', () => {
        const contract = 'packages/cockpit/src/environment/contract.ts'
        const owner = 'packages/cockpit/src/synthetic/owner.ts'
        const found = diagnosticInventoryFromSources(new Map([
            [contract, "export const ENVIRONMENT_CODES = Object.freeze({\n    REGISTERED_FAILURE: 'REGISTERED_FAILURE',\n} as const)\nexport const EXECUTION_FAILURE_CODES = Object.freeze([] as const)\n"],
            [owner, [
                "import { ENVIRONMENT_CODES } from '../environment/contract.js'",
                "function refusal(code: string, message: string, fix?: string) { return { code, message, ...(fix ? { fix } : {}) } }",
                // Named through the registry, as environment codes must be, beside a literal fix.
                "export function registered() { return { code: ENVIRONMENT_CODES.REGISTERED_FAILURE, message: 'm', fix: 'repair the registered input' } }",
                "export function agreedFirst() { return { code: 'AGREED_FAILURE', message: 'm', fix: 'repair the shared input' } }",
                "export function agreedSecond() { return refusal('AGREED_FAILURE', 'm', 'repair the shared input') }",
                "export function differingFirst() { return { code: 'DIFFERING_FAILURE', message: 'm', fix: 'repair the first input' } }",
                "export function differingSecond() { return refusal('DIFFERING_FAILURE', 'm', 'repair the second input') }",
                // One place states a fix and another computes its own: neither is the code's fix.
                "export function partialFirst() { return { code: 'PARTIAL_FAILURE', message: 'm', fix: 'repair the partial input' } }",
                "export function partialSecond(detail: string) { return { code: 'PARTIAL_FAILURE', message: 'm', fix: `repair ${detail}` } }",
                // A shared constructor imported under a local name states its fix at the call too.
                "import { shared as refuse } from './shared.js'",
                "export function imported() { return refuse('IMPORTED_FAILURE', 'm', undefined, 'repair the imported input') }",
            ].join('\n')],
            ['packages/cockpit/src/synthetic/shared.ts', 'export function shared(code: string, message: string, target?: string, fix?: string) { return { code, message, target, fix } }'],
        ]))
        expect(Object.fromEntries(found.remedies)).toEqual({
            REGISTERED_FAILURE: { kind: 'fixed', fix: 'repair the registered input' },
            AGREED_FAILURE: { kind: 'fixed', fix: 'repair the shared input' },
            DIFFERING_FAILURE: { kind: 'varies' },
            PARTIAL_FAILURE: { kind: 'varies' },
            IMPORTED_FAILURE: { kind: 'fixed', fix: 'repair the imported input' },
        })
    })
})

describe('reference pages', () => {
    it('renders every page from source with its audience, purpose and one terminal newline', async () => {
        const rendered = await renderReferences(sources())
        expect(rendered.map(file => file.path)).toEqual([...wholePaths, 'docs/troubleshooting.md'])
        expect(await renderReferences(sources())).toEqual(rendered)
        const files = new Map(rendered.map(file => [file.path, file.bytes]))
        for (const [path, bytes] of files) expect(bytes, path).toMatch(/[^\n]\n$/)
        expect(files.get('docs/cli-reference.md')).toContain('for users looking up an exact command, flag, exit code or diagnostic')
        expect(files.get('docs/configuration-reference.md')).toContain('for users authoring or reviewing `cockpit.toml`')
        expect(files.get('docs/command-list.md')).toContain('for users choosing the command that owns their next operation')
        expect(files.get('docs/capability-matrix.md')).toContain('for users checking what cockpit actually enforces in each agent tool')
    })

    it('documents every command, flag and exit status, and sends diagnostics to the one remedies table', async () => {
        const cli = (await pages()).get('docs/cli-reference.md')!
        for (const command of commands) {
            expect(cli).toContain(`## cockpit ${command.name}\n`)
            for (const flag of Object.keys(command.options)) expect(cli).toContain(`| \`--${flag}\` |`)
        }
        const section = (name: string, next: string) => cli.slice(cli.indexOf(`## cockpit ${name}\n`), cli.indexOf(`## cockpit ${next}\n`))
        expect(section('sync', 'check')).toContain('| `--adopt` | string | unset |')
        expect(section('sync', 'check')).toContain('Reads `cockpit.toml` from `--config`.')
        expect(section('init', 'setup')).toContain('Does not read `cockpit.toml`.')
        expect(cli).toContain('| 0 | success |\n| 2 | failure |\n| 130 | cancelled |')
        expect(cli).toContain('[Troubleshooting](troubleshooting.md#codes-with-a-fixed-remedy)')
        // Per-command code lists were derived from the source, erred towards too many, and buried
        // the flags; a code's remedy lives in one table.
        expect(cli).not.toContain('SYNTHETIC_FAILURE')
        expect(cli).not.toContain('packages/cockpit/src/')
        // The command list holds commands only.
        expect((await pages()).get('docs/command-list.md')!.split('\n').filter(line => line !== '' && !/^(?:#|<!--|This generated index)/.test(line)))
            .toEqual(commands.map(command => expect.stringMatching(new RegExp(`^- \`cockpit ${command.name}\``))))
    })

    it('lists a code with its fixed remedy or covering section, and no row for any other code', async () => {
        const troubleshooting = `# Troubleshooting\n\n\`OTHER_FAILURE\` is named before any section.\n\n## Guided recovery, step one\n\n\`GUIDED_FAILURE\` means the guide applies.\n\n${begin}\nold index\n${end}\n`
        const page = (await pages({ troubleshooting, diagnostics: inventory({
            BARE_FAILURE: { kind: 'none' }, VARYING_FAILURE: { kind: 'varies' }, OTHER_FAILURE: { kind: 'none' },
            FIXED_FAILURE: { kind: 'fixed', fix: 'repair the input | twice' }, GUIDED_FAILURE: { kind: 'fixed', fix: 'follow the guide' },
        }) })).get('docs/troubleshooting.md')!
        const table = page.slice(page.indexOf('| Diagnostic |'), page.indexOf(end))
        expect(table).toBe('| Diagnostic | What to do |\n| --- | --- |\n'
            + '| `FIXED_FAILURE` | repair the input &#124; twice |\n'
            + '| `GUIDED_FAILURE` | follow the guide; [see above](#guided-recovery-step-one) |\n')
        expect(page.slice(0, page.indexOf(begin))).toBe(troubleshooting.slice(0, troubleshooting.indexOf(begin)))
        expect(page.endsWith(`${end}\n`)).toBe(true)
        // A person looks this warning up to learn how to trust the hook, so the row carries the remedy.
        const real = (await renderReferences(shipped)).find(file => file.path === 'docs/troubleshooting.md')!.bytes
        expect(real).toMatch(/^\| `CODEX_HOOK_UNTRUSTED` \| .*codex -C <cockpit root>.*Trust all and continue.* \|$/m)
        // A gap's fix is chosen per gap, so the table presents none as the code's fix.
        expect(real).not.toContain('`DOCUMENT_GAP`')
    })

    it.each(['', `${begin}\n${begin}\n${end}`, `${end}\n${begin}`, `${begin}\n${end}\n${end}`, `${begin} inline\n${end}`])(
        'refuses ambiguous or malformed region markers: %s', async body => {
            await expect(renderReferences(sources({ troubleshooting: body }))).rejects.toThrow(/cockpit:diagnostic-index/)
        })

    it('keeps the exact CRLF boundary and every byte outside the region', async () => {
        const source = prose.replace(`${begin}\n`, `${begin}\r\n`)
        const page = (await pages({ troubleshooting: source })).get('docs/troubleshooting.md')!
        expect(page).toContain(`${begin}\r\n## Codes with a fixed remedy`)
        expect(page.slice(0, page.indexOf(begin))).toBe(source.slice(0, source.indexOf(begin)))
        expect(page.slice(page.indexOf(end))).toBe(source.slice(source.indexOf(end)))
    })

    it('renders every schema field, constraint and runtime check into the configuration reference', async () => {
        const configuration = (await pages()).get('docs/configuration-reference.md')!
        // The JSON Schema is linked, not inlined: inlined, it was nearly all of an 11,000-line page.
        expect(configuration).toContain('[`cockpit.schema.json`](../packages/cockpit/cockpit.schema.json)')
        expect(configuration).not.toContain('"$schema"')
        expect(configurationReferenceGaps(configuration, JSON.parse(renderCockpitSchema()) as SchemaNode)).toEqual([])
        expect(configuration).toContain(String(configurationDefaults().cockpit.guide_cap))
        // Skill size limits name the files a maintainer edits, not the paths skills install to.
        expect(configuration).toContain('The limits come from `packages/cockpit/surfaces/skills/collection.json`')
        expect(configuration).toContain('Each procedure is read on demand and has no size limit: `packages/cockpit/surfaces/skills/procedures/setup.md`')
        expect(configuration).toMatch(/^\| `packages\/cockpit\/surfaces\/skills\/cockpit-setup\.skill\.md` \| lines \| \d+ \| `packages\/cockpit\/surfaces\/skills\/procedures\/setup\.md` \|$/m)
        expect(configuration).not.toMatch(/`skills\/(?:collection\.json|procedures\/[a-z-]+\.md|[a-z-]+\/SKILL\.md)`/)
    })

    it('derives capability strength from the shipped guards and skills', async () => {
        const matrix = (await pages()).get('docs/capability-matrix.md')!
        const section = (heading: string) => matrix.slice(matrix.indexOf(`## ${heading}\n`)).split(/\n(?=## )/)[0]!
        // One row per harness, one column per capability. Guard firing is enforced only where a dated
        // run of the real tool showed a refusal, and Codex's holds only once a person trusts the hook.
        // Every tool stays in the matrix; the unmeasured ones are written only when listed. The session-start
        // check is generated only where a dated run saw the hook fire and reach the agent.
        expect(matrix).toContain('| Tool | Written | Guard firing | Instruction loading | Skills | Session-start check | Remote MCP servers | Worktree grants |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
            + '| Claude Code (`claudecode`) | by default | enforced | instructed | instructed | instructed | instructed (needs a person) | enforced (needs a person) |\n'
            + '| Codex (`codexcli`) | by default | enforced (needs a person) | instructed | instructed | instructed (needs a person) | instructed | unavailable |\n'
            + '| OpenCode (`opencode`) | by default | enforced | instructed | instructed | unavailable | instructed | enforced |\n'
            + '| Cursor (`cursor`) | when listed | unavailable | generated | generated | unavailable | unavailable | unavailable |\n'
            + '| Grok Build (`grokcli`) | when listed | unavailable | generated | generated | unavailable | unavailable | unavailable |\n')
        expect(section('Without a measurement')).toContain('- Remote MCP servers in Cursor and Grok Build: cockpit writes no remote MCP server for this tool')
        expect(section('Measurements')).toMatch(/^- Codex, guard firing \(\d{4}-\d{2}-\d{2}, version [^)]+\): only after a person trusts the hook: [^\n]+\.$/m)
        expect(section('Measurements')).not.toMatch(/Cursor|Grok Build|skills/)
        // A date reads as a run of the tool, so cells nobody ran carry none.
        expect(section('Without a measurement')).not.toMatch(/\d{4}-\d{2}-\d{2}/)
        expect(section('Without a measurement')).toContain('- Guard firing in Cursor and Grok Build: no guard adapter is checked in, so cockpit generates no guard hook.\n')
        expect(section('Without a measurement')).toContain('- Browser native transports (the playwright MCP tools and the pinned Playwright CLI) in Claude Code, Codex and OpenCode: ')
        expect(matrix).not.toMatch(/pending_evidence|human_needed|not_applicable/)

        await expect(renderReferences(sources({ guardTemplate: '#!/bin/sh\nexit 0\n' }))).rejects.toThrow(/shipped guards/)
        const manifest = (page: string) => /^<!-- Source manifest: ([0-9a-f]{64}) -->$/m.exec(page)?.[1]
        const edited = new Map(shipped.skills)
        edited.set('cockpit-fix', edited.get('cockpit-fix')!.replace(/(\S)\n$/, '$1 Reworded.\n'))
        // The manifest is invisible to readers but moves with any shipped skill byte.
        expect(manifest((await pages({ skills: edited })).get('docs/capability-matrix.md')!)).not.toBe(manifest(matrix))
        const adapters = (shipped.adapters as Record<string, unknown>[]).map(row => row.target === 'codexcli'
            ? { format: row.format, target: row.target, mechanism: 'unavailable', measuredOn: row.measuredOn, measuredVersion: null,
                provenance: 'synthetic unavailable adapter', reason: 'native entry unavailable' } : row)
        const changed = (await pages({ adapters })).get('docs/capability-matrix.md')!
        expect(changed).toContain('| Codex (`codexcli`) | by default | unavailable | instructed | instructed |')
        expect(changed).toContain('- Guard firing in Codex: synthetic unavailable adapter.\n')
    })

    it('copies shipped procedure sections into the adopt-cockpit skill and refuses a template every harness would not load', async () => {
        const skill = (await pages()).get('skills/adopt-cockpit/SKILL.md')!
        expect(skill).toMatch(/^---\nname: adopt-cockpit\ndescription: "[^"\n]+"\n---\n/)
        const setup = shipped.procedures.get('skills/procedures/setup.md')!
        for (const name of ['Bootstrap', 'Create a local setup', 'Secret handling']) {
            const start = setup.indexOf(`## ${name}\n`)
            const next = setup.indexOf('\n## ', start + 1)
            expect(skill).toContain(`#${setup.slice(start, next === -1 ? undefined : next).trimEnd()}`)
        }
        expect(skill).not.toContain('cockpit:procedure-section')
        const changedProcedure = setup.replace('## Create a local setup\n\n', '## Create a local setup\n\nA changed shipped step.\n\n')
        expect((await pages({ procedures: new Map([...shipped.procedures, ['skills/procedures/setup.md', changedProcedure]]) }))
            .get('skills/adopt-cockpit/SKILL.md')).toContain('A changed shipped step.')
        const harnessKey = shipped.adoptSkillTemplate.replace('name: adopt-cockpit\n', 'name: adopt-cockpit\nallowed-tools: [Bash]\n')
        await expect(renderReferences(sources({ adoptSkillTemplate: harnessKey }))).rejects.toThrow(/frontmatter/)
        const missingSection = shipped.adoptSkillTemplate.replace('procedure-section Secret handling', 'procedure-section Absent section')
        await expect(renderReferences(sources({ adoptSkillTemplate: missingSection }))).rejects.toThrow(/Absent section/)
    })
})
