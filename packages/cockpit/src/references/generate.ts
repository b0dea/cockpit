import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

import type { DiagnosticInventory } from '../../../../scripts/diagnostic-inventory.mjs'
import { commands } from '../command-table.js'
import { mechanism as configMechanism } from '../config/load.js'
import { snapshotGeneratedJson } from '../environment/contract.js'
import type { GeneratedSurfaceSelftestProjection } from '../environment/generated-application.js'
import { executeProbe } from '../environment-exec/execute.js'
import { EXIT_CODES } from '../invocation.js'
import { installedPackageMetadata } from '../package-metadata.js'
import {
    admitPublicationPlan, expectedState, readAnchoredEntry, runPublicationPlan,
    type PublicationMutation, type PublicationPlanInput, type PublicationRefusal, type PublicationRunAdapters,
} from '../generated-environment/transaction.js'
import { configurationDefaults, mechanism as schemaMechanism } from '../schema.js'
import { renderCockpitSchema } from '../schema-json.js'
import { SURFACE_TARGETS } from '../surfaces/contract.js'
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
}
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
}
interface CapabilityCell {
    readonly target: string
    readonly capability: string
    readonly skill: string
    readonly state: string
    readonly evidence: string
    readonly provenance: string
    readonly measuredOn: string
    readonly measuredVersion: string | null
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

const WHOLE_PATHS = ['docs/cli-reference.md', 'docs/configuration-reference.md', 'docs/command-list.md', 'docs/capability-matrix.md'] as const
const BEGIN = '<!-- cockpit:diagnostic-index:begin -->'
const END = '<!-- cockpit:diagnostic-index:end -->'
const renderedAuthority = new WeakMap<object, Readonly<{ files: readonly ReferenceFile[]; troubleshootingPreimage: string; committed: boolean }>>()
const committedAuthority = new WeakMap<object, Readonly<{ skills: AdmittedSkillCollection; cells: readonly CapabilityCell[]; sha256: string; sourceAssets: CommittedCapabilityInput['sourceAssets'] }>>()
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const cell = (value: string) => value.replaceAll('|', '&#124;').replaceAll('\n', ' ').replaceAll('\r', ' ')
const code = (value: string) => `\`${cell(value)}\``
const verifiedVersion = `<!-- cockpit:verified version=${installedPackageMetadata.version} -->`
const documentHeading = (title: string) => `# ${title}\n\n${verifiedVersion}\n\n`

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
        for (const row of restrictions.targets) cells.push(Object.freeze({ target: row.target, capability: 'guard-firing', skill: 'n/a',
            state: row.capability, evidence: row.evidenceStatus, provenance: row.provenance, measuredOn: row.measuredOn, measuredVersion: row.measuredVersion }))
        const instructions = shippedInstructionCapabilities()
        if (instructions.length !== SURFACE_TARGETS.length || new Set(instructions.map(row => row.target)).size !== SURFACE_TARGETS.length
            || SURFACE_TARGETS.some(target => !instructions.some(row => row.target === target))) return refusal('shipped instruction capabilities do not cover the fixed targets')
        for (const row of instructions) cells.push(Object.freeze({ target: row.target, capability: 'instruction-loading', skill: 'n/a',
            state: row.capability, evidence: row.evidence, provenance: `${row.mechanism}: ${row.provenance}`, measuredOn: row.characterizedOn, measuredVersion: null }))
        for (const target of SURFACE_TARGETS) for (const skill of skills.skills) {
            const file = skills.files.find(row => row.target === target && row.path.endsWith(`/${skill}/SKILL.md`))
            if (!file) return refusal(`shipped skill output is missing for ${target}:${skill}`, 'surfaces/skills')
            cells.push(Object.freeze({ target, capability: 'skill-parity', skill, state: 'instructed', evidence: 'human_needed',
                provenance: `inspectSkillSet rendered ${file.path}; SHA-256 ${file.sha256}; operator parity judgment pending`, measuredOn: 'unmeasured', measuredVersion: null }))
        }
        const projection = Object.freeze({ kind: 'committed-capabilities' as const })
        committedAuthority.set(projection, Object.freeze({ skills: skills.collection, cells: Object.freeze(cells), sourceAssets: captured.sourceAssets,
            sha256: digest(JSON.stringify({ cells, guardTemplate: digest(captured.guardTemplate), adapters: captured.adapters })) }))
        return Object.freeze({ kind: 'complete', projection, skills: skills.collection })
    } catch (error) {
        return refusal(`committed capability preparation failed: ${error instanceof Error ? error.message : 'invalid shipped bytes'}`)
    }
}

function inventoryCodes(inventory: DiagnosticInventory): readonly string[] | undefined {
    if (!inventory || !Array.isArray(inventory.items) || !(inventory.owners instanceof Map)
        || !(inventory.commandOwners instanceof Map) || [...inventory.commandOwners].some(([handler, owners]) =>
            typeof handler !== 'string' || !(owners instanceof Set) || owners.size === 0
            || [...owners].some(path => typeof path !== 'string' || !/^packages\/cockpit\/src\/[A-Za-z0-9_./-]+\.ts$/.test(path)))) return undefined
    const remedies = inventory.remedies
    const codes = inventory.items.map(item => item.startsWith('diagnostic:') ? item.slice('diagnostic:'.length) : '')
    if (codes.length === 0 || new Set(codes).size !== codes.length || codes.some(name => !/^[A-Z][A-Z0-9_]+$/.test(name))
        || inventory.owners.size !== codes.length || !(remedies instanceof Map) || remedies.size !== codes.length || codes.some(name => {
            const owners = inventory.owners.get(name)
            const fixes = remedies.get(name)
            return !(owners instanceof Set) || owners.size === 0 || [...owners].some(path => typeof path !== 'string' || !/^packages\/cockpit\/src\/[A-Za-z0-9_./-]+\.ts$/.test(path))
                || !(fixes instanceof Set) || [...fixes].some(fix => typeof fix !== 'string' || fix.length === 0 || /[\r\n]/.test(fix))
        })) return undefined
    return [...codes].sort()
}

function inventoryRemedy(inventory: DiagnosticInventory, name: string): string {
    const fixes = [...inventory.remedies.get(name)!].sort()
    return fixes.length === 0 ? 'no static remedy captured; inspect implementing owners' : fixes.map(cell).join('; ')
}

export function validateTroubleshootingIndex(inventory: DiagnosticInventory, bytes: string): readonly string[] {
    const codes = inventoryCodes(inventory)
    if (!codes) return ['diagnostic inventory is not the exact AST owner projection']
    const rows = [...bytes.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| (.+) \| (.+) \|\r?$/gm)]
    const errors: string[] = []
    for (const line of bytes.split(/\r?\n/)) {
        if (/^\s*\|/.test(line) && line !== '| Diagnostic | Implementing owners | Source remedy |' && line !== '| --- | --- | --- |'
            && !/^\| `[A-Z][A-Z0-9_]+` \| .+ \| .+ \|$/.test(line)) errors.push(`malformed troubleshooting row: ${line}`)
    }
    for (const name of codes) {
        const matches = rows.filter(row => row[1] === name)
        if (matches.length !== 1) errors.push(`${name}: expected exactly one troubleshooting row, received ${matches.length}`)
        else {
            if (matches[0]![2] !== [...inventory.owners.get(name)!].sort().map(code).join(', ')) errors.push(`${name}: troubleshooting owners do not resolve`)
            if (matches[0]![3] !== inventoryRemedy(inventory, name)) errors.push(`${name}: troubleshooting remedy is stale`)
        }
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
        const diagnosticRow = (name: string) => `| ${code(name)} | ${[...input.diagnostics.owners.get(name)!].sort().map(code).join(', ')} | ${inventoryRemedy(input.diagnostics, name)} |\n`
        const index = '| Diagnostic | Implementing owners | Source remedy |\n| --- | --- | --- |\n' + codes.map(diagnosticRow).join('')
        const indexErrors = validateTroubleshootingIndex(input.diagnostics, index)
        if (indexErrors.length > 0) return refusal(indexErrors.join('; '))
        const document = replaceIndex(input.troubleshooting, index)
        if (document === undefined) return refusal('troubleshooting needs exactly one ordered pair of standalone diagnostic-index markers', 'docs/troubleshooting.md')
        const defaults = configurationDefaults()
        const exits = Object.entries(EXIT_CODES).map(([name, value]) => `| ${value} | ${name} |\n`).join('')
        const cli = documentHeading('CLI reference') + 'Commands and flags derive from the implementing command table.\n\n' + commands.map(command => {
            const commandOwners = input.diagnostics.commandOwners.get(command.handler)
            const ownedDiagnostics = commandOwners
                ? codes.filter(name => [...input.diagnostics.owners.get(name)!].some(owner => commandOwners.has(owner)))
                : []
            const configuration = command.ordinary.availability === 'available' ? command.ordinary.configuration : 'unavailable'
            const configurationOwners = configuration === 'resolved' ? `${code(configMechanism.module)}, ${code(schemaMechanism.module)}` : 'none'
            return `## cockpit ${command.name}\n\n${command.summary}.\n\nConfiguration: ${code(configuration)}. Owners: ${configurationOwners}.\n\n`
                + '| Flag | Type | Default |\n| --- | --- | --- |\n' + Object.entries(command.options).map(([flag, option]) =>
                    `| ${code(`--${flag}`)} | ${option.type} | ${'default' in option ? code(JSON.stringify(option.default)) : 'unset'} |\n`).join('')
                + (command.ordinary.availability === 'available' && command.ordinary.operationVariants
                    ? '\n| Operation | Configuration | Required flags | Admitted flags |\n| --- | --- | --- | --- |\n'
                        + Object.entries(command.ordinary.operationVariants).map(([operation, variant]) =>
                            `| ${code(operation)} | ${code(variant.configuration)} | ${Object.entries(variant.options).filter(([, option]) => option.required).map(([flag]) => code(`--${flag}`)).join(', ')} | ${Object.keys(variant.options).map(flag => code(`--${flag}`)).join(', ')} |\n`).join('')
                    : '')
                + '\n| Exit | Meaning |\n| --- | --- |\n' + exits
                + '\n| Diagnostic | Implementing owners | Source remedy |\n| --- | --- | --- |\n'
                + (ownedDiagnostics.length > 0 ? ownedDiagnostics.map(diagnosticRow).join('')
                    : commandOwners ? `| unavailable | ${[...commandOwners].sort().map(code).join(', ')} | no diagnostic is statically owned by the captured handler modules |\n`
                        : '| unavailable | unavailable | no static owner binding was captured from CLI dispatch |\n')
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
        const configuration = documentHeading('Configuration reference') + 'The runtime schema and defaults are the configuration authorities.\n\n'
            + '## Defaults\n\n```json\n' + JSON.stringify(defaults, null, 2) + '\n```\n\n'
            + '## Governed standing cost\n\n'
            + `Collection authority: ${code(sourcePath(collection.source.path))}, SHA-256 ${code(collection.source.sha256)}.\n\n`
            + '| Target | Metric | Cap | Displacement |\n| --- | --- | --- | --- |\n' + caps + '\n'
            + '| Entrypoint | Metric | Cap | Displacement |\n| --- | --- | --- | --- |\n' + entrypoints + '\n'
            + `Terminal ${code(sourcePath(collection.terminal.path))}: loading=pull; budget=uncapped; SHA-256 ${code(collection.terminal.sha256)}.\n\n`
            + `<!-- cockpit:ref schema=cockpit.guide_cap --> ${code('cockpit.guide_cap')} derives from the registry schema (default ${defaults.cockpit.guide_cap} lines); measured guide costs are instance-specific and come from the sibling projection owner.\n\n` + guideCosts
            + '\n## JSON Schema\n\n```json\n' + renderCockpitSchema().trim() + '\n```\n'
        const list = documentHeading('Command list') + 'The command table supplies this list.\n\n' + commands.map(command => `- ${code(`cockpit ${command.name}`)}: ${command.summary}.\n`).join('')
            + '\n## Consumer documentation pipeline\n\n```yaml\ndocumentation-pipeline:\n  generate: <declared producer command>\n  check: <declared byte comparison command>\n  named-references: <declared reference validation command>\n```\n'
        const matrix = committed ? documentHeading('Capability matrix') + 'Shipped owner facts retain their evidence strength. Native and operator judgments remain pending where stated.\n\n'
            + `Source manifest: ${code(committed.sha256)}.\n\n| Harness | Capability | Skill | State | Evidence | Provenance | Measured on | Measured version |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`
            + committed.cells.map(row => `| ${cell(row.target)} | ${cell(row.capability)} | ${cell(row.skill)} | ${cell(row.state)} | ${cell(row.evidence)} | ${cell(row.provenance)} | ${cell(row.measuredOn)} | ${cell(row.measuredVersion ?? 'unmeasured')} |\n`).join('')
            : documentHeading('Capability matrix') + 'This projection describes declared surfaces and pending probe cells. A probe expectation grants no enforced capability; missing or unavailable native evidence remains non-authorizing.\n\n'
            + `Source manifest: ${code(expectation!.generatedManifestSha256)}.\n\n| Harness | Capability | Skill | Evidence |\n| --- | --- | --- | --- |\n`
            + expectation!.cells.map(row => `| ${cell(row.harness.kind === 'builtin' ? row.harness.name : row.harness.id)} | ${row.capability} | ${row.capability === 'skill-parity' ? row.skill : 'n/a'} | instructed; native probe pending |\n`).join('')
            + '\nCustom declarations retain their recorded state and measurement date; a declaration alone supplies no native proof.\n\n'
            + ('capabilities' in input ? input.capabilities.declarations : []).flatMap(row => row.capabilities.map(capability =>
                `- ${code(row.name)} ${capability.feature}: ${capability.state}; ${capability.measured_on}.\n`)).join('')
        const contents = [cli, configuration, list, matrix]
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
