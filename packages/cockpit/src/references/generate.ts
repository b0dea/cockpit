import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

import type { DiagnosticInventory } from '../../../../scripts/diagnostic-inventory.mjs'
import { commands } from '../command-table.js'
import { snapshotGeneratedJson } from '../environment/contract.js'
import type { GeneratedSurfaceSelftestProjection } from '../environment/generated-application.js'
import { executeProbe } from '../environment-exec/execute.js'
import { EXIT_CODES } from '../invocation.js'
import {
    admitPublicationPlan, expectedState, readAnchoredEntry, runPublicationPlan,
    type PublicationMutation, type PublicationPlanInput, type PublicationRefusal, type PublicationRunAdapters,
} from '../generated-environment/transaction.js'
import { configurationDefaults } from '../schema.js'
import { renderCockpitSchema } from '../schema-json.js'
import { SURFACE_TARGETS } from '../surfaces/contract.js'
import { harnessFact, type SurfaceTarget } from '../surfaces/harness-registry.js'
import { surfaceSelftestExpectation } from '../surfaces/selftest.js'
import { inspectSkillSet, isAdmittedSkillCollection, type AdmittedSkillCollection } from '../surfaces/skill-contract.js'
import { shippedInstructionCapabilities, type StandingCost } from '../surfaces/projection.js'
import { inspectShippedRestrictionCapabilities } from '../surfaces/restrictions.js'

export const mechanism = {
    id: 'reference-generation',
    module: 'packages/cockpit/src/references/generate.ts',
    exports: ['prepareCommittedCapabilityProjection', 'renderReferences', 'writeReferences', 'validateTroubleshootingIndex'],
} as const

interface ReferenceFile { readonly path: string; readonly bytes: string; readonly sha256: string }
export interface ReferenceInput {
    readonly skills: AdmittedSkillCollection
    readonly capabilities: GeneratedSurfaceSelftestProjection
    readonly guideCosts: readonly StandingCost[]
    readonly diagnostics: DiagnosticInventory
    readonly troubleshooting: string
    readonly adoptSkill: AdoptSkillSources
}
/** The installable adopt-cockpit skill: its template, and the shipped procedure it copies sections from. */
export interface AdoptSkillSources { readonly template: string; readonly procedure: string }
export interface CommittedCapabilityInput {
    readonly guardTemplate: string
    readonly adapters: readonly unknown[]
    readonly skillSources: readonly Readonly<{ path: string; bytes: string }>[]
    readonly collection: Readonly<{ path: string; bytes: string; sha256: string }>
    readonly terminal: Readonly<{ path: string; bytes: string; sha256: string }>
    readonly sourceAssets: readonly Readonly<{ path: string; bytes: string; sha256: string; installedPath: string }>[]
}
export interface CommittedCapabilityProjection { readonly kind: 'committed-capabilities' }
interface CommittedReferenceInput {
    readonly committed: CommittedCapabilityProjection
    readonly diagnostics: DiagnosticInventory
    readonly troubleshooting: string
    readonly adoptSkill: AdoptSkillSources
}
interface CapabilityCell {
    readonly target: SurfaceTarget
    readonly capability: typeof CAPABILITY_COLUMNS[number][0]
    readonly state: string
    readonly evidence: string
    readonly provenance: string
    readonly measuredOn: string
    readonly measuredVersion: string | null
    // The directory the skills render into; null for the cells that are not skills.
    readonly location: string | null
}
export interface RenderedReferences {
    readonly kind: 'complete'
    readonly files: readonly ReferenceFile[]
    readonly troubleshooting: Readonly<{ path: 'docs/troubleshooting.md'; bytes: string; document: string; sha256: string }>
}
export type ReferenceResult = RenderedReferences | PublicationRefusal
export type ReferencePublicationContext = Omit<PublicationPlanInput, 'mode' | 'mutations' | 'references'>
export interface ReferenceWriteInput {
    readonly root: string
    readonly publication: ReferencePublicationContext
    readonly rendered: RenderedReferences
}

const WHOLE_PATHS = ['docs/cli-reference.md', 'docs/configuration-reference.md', 'docs/command-list.md', 'docs/capability-matrix.md',
    'skills/adopt-cockpit/SKILL.md'] as const
const ADOPT_SKILL_TEMPLATE_PATH = 'packages/cockpit/src/references/adopt-cockpit.skill.md'
const SHIPPED_PROCEDURE_PATH = 'packages/cockpit/surfaces/skills/procedures/onboarding.md'
// The template is a hand-written page and keeps its marker; the rendered skill does not.
const TEMPLATE_VERIFIED_MARKER = /^<!-- cockpit:verified version=\S+ -->\n\n?/m
const PROCEDURE_SECTION = /^<!-- cockpit:procedure-section ([A-Za-z][A-Za-z ]*[A-Za-z]) -->$/gm
const BEGIN = '<!-- cockpit:diagnostic-index:begin -->'
const END = '<!-- cockpit:diagnostic-index:end -->'
const renderedAuthority = new WeakMap<object, Readonly<{ files: readonly ReferenceFile[]; troubleshootingPreimage: string; committed: boolean }>>()
const committedAuthority = new WeakMap<object, Readonly<{ skills: AdmittedSkillCollection; cells: readonly CapabilityCell[]; sha256: string; sourceAssets: CommittedCapabilityInput['sourceAssets'] }>>()
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const cell = (value: string) => value.replaceAll('|', '&#124;').replaceAll('\n', ' ').replaceAll('\r', ' ')
const code = (value: string) => `\`${cell(value)}\``
// Generated pages carry no `cockpit:verified` version: regeneration verifies them, and a stamped
// version made every release bump stale every committed reference until it was regenerated.
const GENERATED_NOTE = '<!-- Generated by `npm run references`; edit its sources, not this file. -->'
const documentHeading = (title: string) => `# ${title}\n\n${GENERATED_NOTE}\n\n`

function refusal(message: string, target = 'references'): PublicationRefusal {
    return Object.freeze({ kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
        diagnostics: Object.freeze([{ severity: 'error' as const, code: 'REFERENCE_INPUT_INVALID', message, target }]) })
}

export async function prepareCommittedCapabilityProjection(input: CommittedCapabilityInput): Promise<PublicationRefusal | Readonly<{
    kind: 'complete'; projection: CommittedCapabilityProjection; skills: AdmittedSkillCollection
}>> {
    try {
        const captured = snapshotGeneratedJson(input) as unknown as CommittedCapabilityInput | undefined
        if (!captured || Object.keys(captured).sort().join(',') !== 'adapters,collection,guardTemplate,skillSources,sourceAssets,terminal') return refusal('committed capability preparation requires only the fixed shipped assets')
        const installed = [captured.collection, captured.terminal, ...captured.skillSources]
        if (!Array.isArray(captured.sourceAssets) || captured.sourceAssets.length !== installed.length
            || new Set(captured.sourceAssets.map(source => source.installedPath)).size !== installed.length
            || captured.sourceAssets.some(source => !source || Object.keys(source).sort().join(',') !== 'bytes,installedPath,path,sha256'
                || !/^packages\/cockpit\/surfaces\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(source.path)
                || typeof source.bytes !== 'string' || digest(source.bytes) !== source.sha256
                || !installed.some(asset => asset.path === source.installedPath && asset.bytes === source.bytes))) {
            return refusal('committed source assets must bind every installed asset to its captured bytes', 'surfaces/skills')
        }
        const restrictions = inspectShippedRestrictionCapabilities({ guardTemplate: captured.guardTemplate, adapters: captured.adapters })
        if (restrictions.kind !== 'complete') return refusal(restrictions.message, 'surfaces/guards')
        const skills = await inspectSkillSet({ sources: captured.skillSources, collection: captured.collection, terminal: captured.terminal })
        if (skills.kind !== 'complete') return refusal(skills.diagnostics.map(row => row.message).join('; '), 'surfaces/skills')
        const cells: CapabilityCell[] = []
        for (const row of restrictions.targets) {
            const guard = harnessFact(row.target).guard
            // A dated run of the real tool outranks the adapter's record, but never revives an adapter
            // that no longer emits a hook. The adapter's own date records the transport it was written
            // against, not a run of the tool, so it is never shown as a measurement.
            const firing = row.capability !== 'unavailable' && 'firing' in guard ? guard.firing : undefined
            cells.push(Object.freeze(firing
                ? { target: row.target, capability: 'guard-firing', state: firing.state, evidence: firing.evidence,
                    provenance: firing.provenance, measuredOn: firing.measuredOn, measuredVersion: firing.measuredVersion, location: null }
                : { target: row.target, capability: 'guard-firing', state: row.capability, evidence: row.evidenceStatus,
                    provenance: row.provenance, measuredOn: NEVER_PROBED, measuredVersion: null, location: null }))
        }
        // Without an adapter no guard is generated, so nothing was probed; the registry's date only
        // records when that was decided.
        for (const target of SURFACE_TARGETS) {
            const guard = harnessFact(target).guard
            if (guard.capability === 'unavailable') cells.push(Object.freeze({ target, capability: 'guard-firing',
                state: guard.capability, evidence: 'not_applicable', provenance: guard.reason, measuredOn: NEVER_PROBED, measuredVersion: null, location: null }))
        }
        const instructions = shippedInstructionCapabilities()
        if (instructions.length !== SURFACE_TARGETS.length || new Set(instructions.map(row => row.target)).size !== SURFACE_TARGETS.length
            || SURFACE_TARGETS.some(target => !instructions.some(row => row.target === target))) return refusal('shipped instruction capabilities do not cover the fixed targets')
        for (const row of instructions) cells.push(Object.freeze({ target: row.target, capability: 'instruction-loading',
            state: row.capability, evidence: row.evidence, provenance: row.provenance,
            measuredOn: row.capability === 'generated' ? NEVER_PROBED : row.characterizedOn, measuredVersion: row.measuredVersion, location: null }))
        // A skill's verdict is the harness's, so each harness gets one skills cell: a row per skill
        // repeated one sentence and buried the cells that differ.
        for (const target of SURFACE_TARGETS) {
            const { native, outputs: { skills: location } } = harnessFact(target)
            for (const skill of skills.skills) {
                if (!skills.files.some(row => row.target === target && row.path === `${location}/${skill}/SKILL.md`)) {
                    return refusal(`shipped skill output is missing for ${target}:${skill}`, 'surfaces/skills')
                }
            }
            cells.push(native.state === 'generated'
                ? Object.freeze({ target, capability: 'skill-parity', state: native.state, evidence: 'pending_evidence',
                    provenance: native.reason, measuredOn: NEVER_PROBED, measuredVersion: null, location })
                : Object.freeze({ target, capability: 'skill-parity', state: 'instructed', evidence: 'human_needed',
                    provenance: 'a person has not yet reviewed whether the tool loads and triggers them as written', measuredOn: NEVER_PROBED, measuredVersion: null, location }))
        }
        // The rendered skill digests stay out of the table but in the manifest, so editing a skill
        // still changes the published source manifest.
        const renderedSkills = skills.files.map(file => [file.target, file.path, file.sha256])
        const projection = Object.freeze({ kind: 'committed-capabilities' as const })
        committedAuthority.set(projection, Object.freeze({ skills: skills.collection, cells: Object.freeze(cells), sourceAssets: captured.sourceAssets,
            sha256: digest(JSON.stringify({ cells, renderedSkills, guardTemplate: digest(captured.guardTemplate), adapters: captured.adapters })) }))
        return Object.freeze({ kind: 'complete', projection, skills: skills.collection })
    } catch (error) {
        return refusal(`committed capability preparation failed: ${error instanceof Error ? error.message : 'invalid shipped bytes'}`)
    }
}

// The installable skill is read by every harness and by the skills CLI before cockpit is
// installed, so its frontmatter carries only the two keys all of them accept; any other key
// would make it load in one tool and break in another.
function adoptSkillFrontmatter(template: string): string | undefined {
    const match = /^---\n(name: adopt-cockpit\ndescription: "[^"\n]+"\n)---\n/.exec(template)
    return match ? match[0] : undefined
}

function procedureSection(procedure: string, name: string): string | undefined {
    const headings = [...procedure.matchAll(/^## (.+)$/gm)]
    const index = headings.findIndex(heading => heading[1] === name)
    if (index === -1 || headings.filter(heading => heading[1] === name).length !== 1) return undefined
    const start = headings[index]!.index!
    const end = headings[index + 1]?.index ?? procedure.length
    return `#${procedure.slice(start, end).trimEnd()}`
}

// Sections are copied, never paraphrased: the procedure cockpit installs into a consumer's
// checkout and the skill an agent installs before cockpit exists must give the same steps.
function renderAdoptSkill(sources: AdoptSkillSources): string {
    const frontmatter = adoptSkillFrontmatter(sources.template)
    if (!frontmatter) throw new Error(`${ADOPT_SKILL_TEMPLATE_PATH} frontmatter must be exactly name: adopt-cockpit and a quoted description`)
    const markers = [...sources.template.matchAll(PROCEDURE_SECTION)]
    if (markers.length === 0) throw new Error(`${ADOPT_SKILL_TEMPLATE_PATH} names no procedure section`)
    const body = sources.template.slice(frontmatter.length).replace(TEMPLATE_VERIFIED_MARKER, '').replace(PROCEDURE_SECTION, (_marker, name: string) => {
        const section = procedureSection(sources.procedure, name)
        if (section === undefined) throw new Error(`${SHIPPED_PROCEDURE_PATH} has no single section "## ${name}"`)
        return section
    })
    return `${frontmatter}\n<!-- Generated by \`npm run references\` from ${ADOPT_SKILL_TEMPLATE_PATH} and ${SHIPPED_PROCEDURE_PATH}; edit those, not this file. -->\n${body}`
}

function inventoryCodes(inventory: DiagnosticInventory): readonly string[] | undefined {
    if (!inventory || !Array.isArray(inventory.items) || !(inventory.owners instanceof Map)
        || !(inventory.commandDiagnostics instanceof Map)) return undefined
    const remedies = inventory.remedies
    const codes = inventory.items.map(item => item.startsWith('diagnostic:') ? item.slice('diagnostic:'.length) : '')
    if (codes.length === 0 || new Set(codes).size !== codes.length || codes.some(name => !/^[A-Z][A-Z0-9_]+$/.test(name))
        || inventory.owners.size !== codes.length
        || !(remedies instanceof Map) || remedies.size !== codes.length || codes.some(name => {
            const owners = inventory.owners.get(name)
            const remedy = remedies.get(name)
            return !(owners instanceof Set) || owners.size === 0 || [...owners].some(path => typeof path !== 'string' || !/^packages\/cockpit\/src\/[A-Za-z0-9_./-]+\.ts$/.test(path))
                || !remedy || !(remedy.kind === 'none' || remedy.kind === 'varies'
                    || remedy.kind === 'fixed' && typeof remedy.fix === 'string' && remedy.fix.length > 0 && !/[\r\n]/.test(remedy.fix))
        })) return undefined
    const known = new Set(codes)
    if ([...inventory.commandDiagnostics].some(([handler, emitted]) => typeof handler !== 'string' || !(emitted instanceof Set)
        || [...emitted].some(name => !known.has(name)))) return undefined
    return [...codes].sort()
}

// Users look a code up to learn what to do. Which source file raises it is maintainer detail that
// `rg <CODE> packages/cockpit/src` answers, so the user pages never list owners or test commands.
const DIAGNOSTIC_HEADER = '| Diagnostic | What to do |\n| --- | --- |\n'
const NO_FIXED_REMEDY = 'see the message'
const VARYING_REMEDY = 'depends on what failed; see the message'
const NEVER_PROBED = 'never'
const DIAGNOSTIC_GUIDE = 'Each diagnostic message names what failed and how to fix it. Where every place that raises a code gives the same fix, the table repeats it; '
    + `where they give different fixes it says "${VARYING_REMEDY}", and otherwise "${NO_FIXED_REMEDY}". `
    + '[Respond to diagnostic codes](environment.md#respond-to-diagnostic-codes) explains each family of codes.\n\n'

// The per-command tables in the CLI reference send the reader somewhere useful: a fix that never
// changes, or the hand-written troubleshooting section that covers the code. Repeating "see the
// message" on nearly every row told the reader nothing, so codes without either get no such column.
const CLI_DIAGNOSTIC_GUIDE = 'Each diagnostic message names what failed and how to fix it. For each command, What to do repeats a fix that never changes '
    + 'and links the [Troubleshooting](troubleshooting.md) section that covers the code; the other codes are listed on their own, and their message is the guidance. '
    + '[Respond to diagnostic codes](environment.md#respond-to-diagnostic-codes) explains each family of codes.\n\n'
    + 'Each command lists the codes its code path can produce, derived from the source, so a list can name a code that needs a failure your setup never meets.\n\n'
const EVERY_COMMAND_GUIDE = 'Every command can produce these codes, so they are listed once, here, and not under each command:\n\n'

const headingAnchor = (heading: string) => heading.trim().toLowerCase().replace(/[`*~]/g, '').replace(/[^a-z0-9 _-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')

// Maps each code to the hand-written section that covers it: a heading named after the code wins,
// otherwise the first section that mentions it. Only the prose before the generated index counts.
function troubleshootingSections(document: string): ReadonlyMap<string, string> {
    const own = new Map<string, string>()
    const mentioned = new Map<string, string>()
    let anchor: string | undefined
    for (const line of document.slice(0, document.indexOf(BEGIN)).split(/\r?\n/)) {
        const heading = /^#{2,6}\s+(.+)$/.exec(line)
        if (heading) {
            anchor = headingAnchor(heading[1]!)
            const named = /^`?([A-Z][A-Z0-9_]+)`?$/.exec(heading[1]!.trim())
            if (named && !own.has(named[1]!)) own.set(named[1]!, anchor)
            continue
        }
        if (anchor === undefined) continue
        for (const match of line.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) if (!mentioned.has(match[1]!)) mentioned.set(match[1]!, anchor)
    }
    return new Map([...mentioned, ...own])
}

function inventoryRemedy(inventory: DiagnosticInventory, name: string): string {
    const remedy = inventory.remedies.get(name)!
    return remedy.kind === 'fixed' ? cell(remedy.fix) : remedy.kind === 'varies' ? VARYING_REMEDY : NO_FIXED_REMEDY
}

export function validateTroubleshootingIndex(inventory: DiagnosticInventory, bytes: string): readonly string[] {
    const codes = inventoryCodes(inventory)
    if (!codes) return ['diagnostic inventory is not the exact AST owner projection']
    const rows = [...bytes.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| (.+) \|\r?$/gm)]
    const errors: string[] = []
    for (const line of bytes.split(/\r?\n/)) {
        if (/^\s*\|/.test(line) && line !== '| Diagnostic | What to do |' && line !== '| --- | --- |'
            && !/^\| `[A-Z][A-Z0-9_]+` \| .+ \|$/.test(line)) errors.push(`malformed troubleshooting row: ${line}`)
    }
    for (const name of codes) {
        const matches = rows.filter(row => row[1] === name)
        if (matches.length !== 1) errors.push(`${name}: expected exactly one troubleshooting row, received ${matches.length}`)
        else if (matches[0]![2] !== inventoryRemedy(inventory, name)) errors.push(`${name}: troubleshooting remedy is stale`)
    }
    for (const row of rows) if (!codes.includes(row[1]!)) errors.push(`${row[1]}: orphan troubleshooting row`)
    return errors
}

function replaceIndex(document: string, bytes: string): string | undefined {
    const tokens = [...document.matchAll(/<!--\s*cockpit:diagnostic-index[^\r\n]*?(?:-->|$)/g)]
    if (tokens.length !== 2 || tokens[0]![0] !== BEGIN || tokens[1]![0] !== END) return undefined
    for (const token of tokens) {
        const start = token.index!
        if ((start !== 0 && document[start - 1] !== '\n') || !/^(?:\r?\n|$)/.test(document.slice(start + token[0].length))) return undefined
    }
    const contentStart = tokens[0]!.index! + BEGIN.length
    const newline = document.slice(contentStart).match(/^\r?\n/)?.[0]
    if (!newline) return undefined
    return document.slice(0, contentStart) + newline + bytes + document.slice(tokens[1]!.index!)
}

const CAPABILITY_COLUMNS = [['guard-firing', 'Guard firing'], ['instruction-loading', 'Instruction loading'], ['skill-parity', 'Skills']] as const
const MATRIX_STATES = 'Each cell holds one of four states:\n\n'
    + '- `enforced`: a dated run of the real tool, beside a deliberately broken control, showed it refusing the forbidden operation.\n'
    + '- `instructed`: cockpit writes the guidance or setting, but nothing makes the agent follow it.\n'
    + '- `generated`: cockpit writes the files, but nobody has checked that the tool even loads them.\n'
    + '- `unavailable`: cockpit writes nothing for this cell.\n\n'
    + 'Only a dated run of the real tool changes a state; writing a file or passing cockpit\'s own tests never does.\n\n'

const listed = (names: readonly string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

function renderCapabilityMatrix(cells: readonly CapabilityCell[], manifestSha256: string, skills: readonly string[]): string {
    const name = (target: SurfaceTarget) => harnessFact(target).displayName
    const at = (target: SurfaceTarget, capability: CapabilityCell['capability']) => {
        const rows = cells.filter(row => row.target === target && row.capability === capability)
        if (rows.length !== 1) throw new Error(`capability matrix needs exactly one ${capability} cell for ${target}`)
        return rows[0]!
    }
    // A verdict that holds only once a person acts says so where the reader looks first; the skills'
    // pending review is a maintainer's task and does not condition their use.
    const state = (row: CapabilityCell) => row.measuredOn !== NEVER_PROBED && row.evidence === 'human_needed' ? `${row.state} (needs a person)` : row.state
    const grid = `| Tool | ${CAPABILITY_COLUMNS.map(([, label]) => label).join(' | ')} |\n| --- |${' --- |'.repeat(CAPABILITY_COLUMNS.length)}\n`
        + SURFACE_TARGETS.map(target => `| ${cell(name(target))} (${code(target)}) | ${CAPABILITY_COLUMNS.map(([capability]) => cell(state(at(target, capability)))).join(' | ')} |\n`).join('')
    const entries = CAPABILITY_COLUMNS.flatMap(([capability, label]) => SURFACE_TARGETS.map(target => ({ label, row: at(target, capability) })))
    const measured = entries.filter(({ row }) => row.measuredOn !== NEVER_PROBED).map(({ label, row }) =>
        `- ${cell(name(row.target))}, ${label.toLowerCase()} (${row.measuredOn}, version ${cell(row.measuredVersion ?? 'not recorded')}): ${cell(row.provenance)}.\n`)
    // Cells nobody has run are grouped by their shared reason, so several harnesses with one gap read as one line.
    const pending = new Map<string, { label: string; provenance: string; targets: string[] }>()
    for (const { label, row } of entries.filter(({ row }) => row.measuredOn === NEVER_PROBED)) {
        const key = JSON.stringify([label, row.state, row.provenance])
        const where = row.location === null ? name(row.target) : `${name(row.target)} (${code(row.location)})`
        const group = pending.get(key) ?? { label, provenance: row.provenance, targets: [] }
        group.targets.push(where)
        pending.set(key, group)
    }
    const unmeasured = [...pending.values()].map(({ label, provenance, targets }) => `- ${label} in ${listed(targets.map(cell))}: ${cell(provenance)}.\n`)
    // Readers have no use for the manifest, but it changes with any shipped skill or guard byte, so
    // the reference check reports this page stale until it is regenerated.
    return documentHeading('Capability matrix')
        + `<!-- Source manifest: ${manifestSha256} -->\n\n`
        + 'This generated page is for users checking what cockpit actually enforces in each agent tool. ' + MATRIX_STATES
        + `Guard firing is the generated hook refusing a protected operation. Instruction loading is the tool reading the guidance cockpit writes for it, including the guides of sibling repositories. Skills are the tool loading the skills cockpit renders: ${listed(skills.map(code))}.\n\n`
        + grid
        + '\n## Measurements\n\nEach line gives the date and tool version of the run and what it showed.\n\n' + measured.join('')
        + '\n## Without a measurement\n\n' + unmeasured.join('')
}

export function renderReferences(input: ReferenceInput | CommittedReferenceInput): ReferenceResult {
    try {
        const committed = 'committed' in input ? committedAuthority.get(input.committed) : undefined
        if ('committed' in input && !committed) return refusal('committed capability projection was not issued by the shipped owners')
        const collection = committed?.skills ?? ('skills' in input ? input.skills : undefined)
        if (!isAdmittedSkillCollection(collection)) return refusal('skill cap metadata was not admitted by its implementing owner')
        const expectation = 'capabilities' in input ? surfaceSelftestExpectation(input.capabilities) : undefined
        if (!committed && !expectation) return refusal('capability projection was not accepted by the surface selftest owner')
        const codes = inventoryCodes(input.diagnostics)
        if (!codes) return refusal('diagnostic inventory is malformed or has unresolved owners')
        const diagnosticRow = (name: string) => `| ${code(name)} | ${inventoryRemedy(input.diagnostics, name)} |\n`
        const table = DIAGNOSTIC_HEADER + codes.map(diagnosticRow).join('')
        const indexErrors = validateTroubleshootingIndex(input.diagnostics, table)
        if (indexErrors.length > 0) return refusal(indexErrors.join('; '))
        const index = DIAGNOSTIC_GUIDE + table
        const document = replaceIndex(input.troubleshooting, index)
        if (document === undefined) return refusal('troubleshooting needs exactly one ordered pair of standalone diagnostic-index markers', 'docs/troubleshooting.md')
        const defaults = configurationDefaults()
        const exits = Object.entries(EXIT_CODES).map(([name, value]) => `| ${value} | ${name} |\n`).join('')
        const sections = troubleshootingSections(input.troubleshooting)
        const guidance = (name: string) => {
            const remedy = input.diagnostics.remedies.get(name)!
            const anchor = sections.get(name)
            return [...(remedy.kind === 'fixed' ? [cell(remedy.fix)] : []), ...(anchor === undefined ? [] : [`[Troubleshooting](troubleshooting.md#${anchor})`])].join('; ')
        }
        const commandDiagnostics = (names: readonly string[]) => {
            const rows = names.map(name => [code(name), guidance(name)] as const)
            const guided = rows.filter(([, text]) => text !== '')
            const other = rows.filter(([, text]) => text === '')
            return [
                ...(guided.length > 0 ? [DIAGNOSTIC_HEADER + guided.map(([name, text]) => `| ${name} | ${text} |\n`).join('')] : []),
                ...(other.length > 0 ? [`| ${guided.length > 0 ? 'Other diagnostics' : 'Diagnostic'} |\n| --- |\n` + other.map(([name]) => `| ${name} |\n`).join('')] : []),
            ].join('\n')
        }
        const emittedBy = (handler: string) => codes.filter(name => input.diagnostics.commandDiagnostics.get(handler)?.has(name) === true)
        const everyCommand = emittedBy(commands[0]!.handler).filter(name => commands.every(command => emittedBy(command.handler).includes(name)))
        const cli = documentHeading('CLI reference')
            + 'This generated reference is for users looking up an exact command, flag, exit code or diagnostic. '
            + 'It is generated from the CLI, so it matches this version; `cockpit <command> --help` shows the same flags.\n\n'
            + CLI_DIAGNOSTIC_GUIDE + (everyCommand.length > 0 ? EVERY_COMMAND_GUIDE + commandDiagnostics(everyCommand) + '\n' : '')
            + commands.map(command => {
            const ownedDiagnostics = emittedBy(command.handler).filter(name => !everyCommand.includes(name))
            return `## cockpit ${command.name}\n\n${command.summary}.\n\n`
                + ('experimental' in command && command.experimental ? 'Status: experimental. This interface may change before a stable release.\n\n' : '')
                + ('config' in command.options ? 'Reads `cockpit.toml` from `--config`.\n\n' : 'Does not read `cockpit.toml`.\n\n')
                + '| Flag | Type | Default |\n| --- | --- | --- |\n' + Object.entries(command.options).map(([flag, option]) =>
                    `| ${code(`--${flag}`)} | ${option.type} | ${'default' in option ? code(JSON.stringify(option.default)) : 'unset'} |\n`).join('')
                + '\n| Exit | Meaning |\n| --- | --- |\n' + exits
                + (ownedDiagnostics.length > 0 ? '\n' + commandDiagnostics(ownedDiagnostics)
                    : '\nNo diagnostic codes are listed for this command; its messages name what failed and how to fix it.\n')
        }).join('\n')
        const sourcePath = (path: string) => {
            if (!committed) return path
            const source = committed.sourceAssets.find(asset => asset.installedPath === path)
            if (!source) throw new Error(`captured repository source is missing for installed asset ${path}`)
            return source.path
        }
        const caps = SURFACE_TARGETS.map(target => `| ${target} | ${collection.metric} | ${collection.caps[target]} | ${code(sourcePath(collection.displacement))} |\n`).join('')
        const entrypoints = collection.entrypoints.map(entry => `| ${code(sourcePath(entry.path))} | ${entry.metric} | ${entry.cap} | ${code(sourcePath(entry.displacement))} |\n`).join('')
        const guideCosts = ('guideCosts' in input ? input.guideCosts : []).map(cost => cost.status === 'unavailable' ? `- ${cost.target}: unavailable (${cell(cost.reason)}).\n`
            : `- ${cost.target}: ${cost.value}/${cost.cap} ${cost.metric}; ${cost.status}; ${cell(cost.provenance)} (${cost.measuredOn}).\n`).join('')
        const configuration = documentHeading('Configuration reference')
            + 'This generated reference is for users authoring or reviewing `cockpit.toml`. It is generated from the schema cockpit validates against, so it matches this version.\n\n'
            + '## Defaults\n\n```json\n' + JSON.stringify(defaults, null, 2) + '\n```\n\n'
            + '## Skill size limits\n\n'
            + 'Agent tools load every skill\'s frontmatter into each session and its entry point whenever the skill is used, so cockpit caps both and keeps the detail in a procedure file the agent reads only when it needs it. '
            + `The limits come from ${code(sourcePath(collection.source.path))}, SHA-256 ${code(collection.source.sha256)}.\n\n`
            + '| Target | Measured as | Limit | Detail moved to |\n| --- | --- | --- | --- |\n' + caps + '\n'
            + '| Skill entry point | Measured as | Limit | Detail moved to |\n| --- | --- | --- | --- |\n' + entrypoints + '\n'
            + `The procedure ${code(sourcePath(collection.terminal.path))} is read on demand and has no size limit; SHA-256 ${code(collection.terminal.sha256)}.\n\n`
            + `<!-- cockpit:ref schema=cockpit.guide_cap --> ${code('cockpit.guide_cap')} limits always-loaded guidance to ${defaults.cockpit.guide_cap} lines by default. The measured cost depends on each configuration's sibling guides, so it is not listed here.\n\n` + guideCosts
            + '\n## JSON Schema\n\n```json\n' + renderCockpitSchema().trim() + '\n```\n'
        const list = documentHeading('Command list')
            + 'This generated index is for users choosing the command that owns their next operation. The command table supplies this list.\n\n'
            + commands.map(command => `- ${code(`cockpit ${command.name}`)}${'experimental' in command && command.experimental ? ' (experimental)' : ''}: ${command.summary}.\n`).join('')
        const matrix = committed ? renderCapabilityMatrix(committed.cells, committed.sha256, collection.skills)
            : documentHeading('Capability matrix') + MATRIX_STATES + 'This version lists the cells that `cockpit selftest` would test for one configuration. Listing a cell confirms nothing, and a missing test result never counts as confirmation.\n\n'
            + `<!-- Source manifest: ${expectation!.generatedManifestSha256} -->\n\n| Harness | Capability | Skill | Evidence |\n| --- | --- | --- | --- |\n`
            + expectation!.cells.map(row => `| ${cell(row.harness.kind === 'builtin' ? row.harness.name : row.harness.id)} | ${row.capability} | ${row.capability === 'skill-parity' ? row.skill : 'n/a'} | instructed; native probe pending |\n`).join('')
            + '\nCustom declarations retain their recorded state and measurement date; a declaration alone supplies no native proof.\n\n'
            + ('capabilities' in input ? input.capabilities.declarations : []).flatMap(row => row.capabilities.map(capability =>
                `- ${code(row.name)} ${capability.feature}: ${capability.state}; ${capability.measured_on}.\n`)).join('')
        if (committed) {
            const shipped = committed.sourceAssets.find(asset => asset.installedPath === 'skills/procedures/onboarding.md')
            if (shipped?.bytes !== input.adoptSkill.procedure) return refusal('adopt-cockpit skill procedure is not the captured shipped procedure', SHIPPED_PROCEDURE_PATH)
        }
        const contents = [cli, configuration, list, matrix, renderAdoptSkill(input.adoptSkill)]
        const files = Object.freeze(WHOLE_PATHS.map((path, index) => Object.freeze({ path, bytes: contents[index]!, sha256: digest(contents[index]!) })))
        const troubleshooting = Object.freeze({ path: 'docs/troubleshooting.md' as const, bytes: index, document, sha256: digest(document) })
        const rendered = Object.freeze({ kind: 'complete' as const, files, troubleshooting })
        renderedAuthority.set(rendered, Object.freeze({ files: Object.freeze([...files, Object.freeze({ path: troubleshooting.path, bytes: document, sha256: troubleshooting.sha256 })]),
            troubleshootingPreimage: digest(input.troubleshooting), committed: committed !== undefined }))
        return rendered
    } catch (error) {
        return refusal(`reference projection failed: ${error instanceof Error ? error.message : 'invalid owner data'}`)
    }
}

export async function writeReferences(input: ReferenceWriteInput, adapters: Pick<PublicationRunAdapters, 'revalidate'> & Partial<Pick<PublicationRunAdapters, 'execute' | 'dryRun'>>): Promise<PublicationRefusal | Readonly<{ kind: 'complete'; committed: readonly Readonly<{ path: string; sha256: string }>[] }>> {
    const rendered = renderedAuthority.get(input.rendered)
    if (!rendered || !rendered.committed || !isAbsolute(input.root) || input.root !== input.publication.authority.root) return refusal('reference publication needs its exact committed render and resolved repository authority')
    const execute = adapters.execute ?? executeProbe
    const publication = input.publication
    const mutations: PublicationMutation[] = []
    for (const file of rendered.files) {
        const observed = await readAnchoredEntry(input.root, file.path, 16_777_216, publication.node, { execute })
        const expected = expectedState(observed)
        if (!expected || observed.kind !== 'file' && observed.kind !== 'missing') return refusal('reference destination is not an anchored regular file or missing path', file.path)
        if (file.path === 'docs/troubleshooting.md' && (observed.kind !== 'file' || observed.sha256 !== rendered.troubleshootingPreimage)) return refusal('troubleshooting changed since its bounded projection', file.path)
        if (observed.kind === 'file' && observed.sha256 === file.sha256) continue
        mutations.push(Object.freeze({ path: file.path, phase: 'desired', operation: 'write-file', expected, bytes: file.bytes, sha256: file.sha256 }))
    }
    const admitted = await admitPublicationPlan({ ...publication, mode: 'reference', mutations,
        references: [...input.rendered.files.map(({ path, sha256 }) => ({ kind: 'file' as const, path, sha256 })), {
            kind: 'markdown-region' as const, path: 'docs/troubleshooting.md', begin: BEGIN, end: END,
            preimageSha256: rendered.troubleshootingPreimage,
            regionSha256: digest(input.rendered.troubleshooting.bytes), postimageSha256: input.rendered.troubleshooting.sha256,
        }] }, { execute })
    if (admitted.kind !== 'complete') return admitted
    const result = await runPublicationPlan(admitted.plan, { execute, revalidate: adapters.revalidate, ...(adapters.dryRun === undefined ? {} : { dryRun: adapters.dryRun }) })
    if (result.kind !== 'complete') return result
    const hashes = new Map(rendered.files.map(file => [file.path, file.sha256]))
    if (publication.nextLedgerBytes !== null) hashes.set('.cockpit/generated-reference-ownership.json', digest(publication.nextLedgerBytes))
    if (result.committedPaths.some(path => !hashes.has(path))) return refusal('transaction returned an undeclared reference destination')
    return Object.freeze({ kind: 'complete', committed: Object.freeze(result.committedPaths.map(path => Object.freeze({ path, sha256: hashes.get(path)! }))) })
}
