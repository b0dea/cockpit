import { installedPackageMetadata } from "../package-metadata.js"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { isProxy, isUint8Array } from "node:util/types"

import { createHash } from 'node:crypto'

import { snapshotGeneratedJson, type JsonSnapshot, type JsonSnapshotObject, RefusalError, tryParseJson } from '../environment/contract.js'
import { publicationCockpitId } from '../environment/identity.js'
import { safeSurfacePath as safePath } from './contract.js'
import { SURFACE_TARGETS } from './harness-registry.js'
import { exactKeys } from '../exact-keys.js'

export type SurfaceOwnership = 'whole-file' | 'shared-region'
export type SurfaceScope = 'always' | 'scoped'
export type SurfaceCapability = 'enforced' | 'instructed'

interface SurfaceEntryBase {
    readonly path: string
    readonly harnesses: readonly [string, ...string[]]
    readonly scope: SurfaceScope
    readonly capability: SurfaceCapability
    readonly writer: 'cockpit'
    readonly schemaVersion: 1
}

export interface OpenCodeRootMember { readonly key: string; readonly valueBytes: string }

export type SurfaceDesiredEntry =
    | Readonly<SurfaceEntryBase & { kind: 'file'; ownership: 'whole-file'; bytes: string; sha256: string }>
    | Readonly<SurfaceEntryBase & {
          kind: 'shared-region'; ownership: 'shared-region'; regionId: string
          region: Readonly<
              | { format: 'markdown-delimited'; begin: string; end: string; bytes: string; sha256: string }
              | { format: 'opencode-json-root-properties'; members: readonly OpenCodeRootMember[]; sha256: string }
          >
      }>

export type SurfacePriorOwnedEntry =
    | Readonly<SurfaceEntryBase & { kind: 'file'; ownership: 'whole-file'; sha256: string }>
    | Readonly<SurfaceEntryBase & { kind: 'shared-region'; ownership: 'shared-region'; regionId: string
          region: Readonly<
              | { format: 'markdown-delimited'; begin: string; end: string; sha256: string }
              | { format: 'opencode-json-root-properties'; keys: readonly string[]; sha256: string }
          >
      }>

export interface SurfaceDiagnostic {
    readonly code: 'SURFACE_INPUT_INVALID' | 'SURFACE_BOUNDS' | 'SURFACE_PATH_CONFLICT'
        | 'SURFACE_OWNERSHIP_INVALID' | 'SURFACE_STATE_CONFLICT'
    readonly message: string
    readonly target?: string
    readonly fix?: string
}

// An agent once read "delete the file" as permission and deleted a file without asking. A hand
// edit is the person's work: say where it belongs, and that discarding it is their call.
export const SURFACE_HAND_EDIT_FIX = 'keep the edit by moving it into cockpit.toml or a surface overlay, then ask the person who owns the cockpit before you discard the hand edit (undo it or delete the file), and rerun npx --no cockpit sync --config <your cockpit.toml>'
export const SURFACE_UNRECORDED_FIX = 'ask the person who owns the cockpit whether this file is theirs; move anything they want kept into cockpit.toml or a surface overlay, and only with their approval move the file away or delete it, then rerun npx --no cockpit sync --config <your cockpit.toml>'

export type SurfaceOwnershipResult =
    | Readonly<{ kind: 'complete'; entries: readonly SurfaceDesiredEntry[] }>
    | Readonly<{ kind: 'refusal'; diagnostic: SurfaceDiagnostic }>

export interface SurfaceOwnershipInput {
    readonly configuredHarnesses: readonly string[]
    readonly entries: readonly SurfaceDesiredEntry[]
}

const SHA256 = /^[a-f0-9]{64}$/
const HARNESS = /^[a-z0-9][a-z0-9-]{0,127}$/
const MAX_ENTRIES = 256
const MAX_FILE_BYTES = 65_536
const MAX_TOTAL_BYTES = 4_194_304
const SHARED_FILE_MAX_BYTES = 16_777_216
const MARKDOWN = Object.freeze({
    'AGENTS.md': { regionId: 'cockpit-instructions', begin: '<!-- cockpit:instructions:start -->', end: '<!-- cockpit:instructions:end -->' },
    'CLAUDE.md': { regionId: 'cockpit-instructions', begin: '<!-- cockpit:instructions:start -->', end: '<!-- cockpit:instructions:end -->' },
} as const)
const OPENCODE_PATH = 'opencode.jsonc'
const OPENCODE_REGION = 'cockpit-opencode-root-properties'
const OPENCODE_KEYS = new Set(['$schema', 'instructions', 'mcp', 'permission'])
const OWNER_ID = /^cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}$/
const OWNER_PREFIX = 'cockpit:owner:'

function ownerMarkers(id: string, format: 'markdown' | 'json'): readonly [string, string] {
    return format === 'markdown'
        ? [`<!-- ${OWNER_PREFIX}${id}:start -->`, `<!-- ${OWNER_PREFIX}${id}:end -->`]
        : [`/* ${OWNER_PREFIX}${id}:start */`, `/* ${OWNER_PREFIX}${id}:end */`]
}

function openCodeOwner(regionId: string): string | undefined {
    const id = regionId.slice(OPENCODE_REGION.length + 1)
    return regionId.startsWith(`${OPENCODE_REGION}:`) && OWNER_ID.test(id) ? id : undefined
}

function markdownOwner(bytes: string): string | undefined {
    const match = /^<!-- cockpit:owner:(cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}):start -->\n/.exec(bytes)
    if (!match) return undefined
    const [begin, end] = ownerMarkers(match[1]!, 'markdown')
    return bytes.endsWith(`${end}\n`) && bytes.split(OWNER_PREFIX).length === 3
        && bytes.slice(begin.length + 1, -end.length - 1).endsWith('\n') ? match[1] : undefined
}

export function bindSurfaceOwnershipIdentity(entries: readonly SurfaceDesiredEntry[], cockpitId: string): SurfaceOwnershipResult {
    if (!OWNER_ID.test(cockpitId)) return refusal('SURFACE_OWNERSHIP_INVALID', 'shared ownership requires an exact cockpit identity')
    const bound: SurfaceDesiredEntry[] = []
    for (const entry of entries) {
        if (entry.kind === 'shared-region' && entry.region.format === 'opencode-json-root-properties') {
            bound.push({ ...entry, regionId: `${OPENCODE_REGION}:${cockpitId}` })
            continue
        }
        if (entry.kind !== 'shared-region' || entry.region.format !== 'markdown-delimited') { bound.push(entry); continue }
        if (entry.region.bytes.includes(OWNER_PREFIX)) return refusal('SURFACE_OWNERSHIP_INVALID', 'generated Markdown body contains a reserved owner marker', entry.path)
        const [begin, end] = ownerMarkers(cockpitId, 'markdown')
        const bytes = `${begin}\n${entry.region.bytes}${end}\n`
        bound.push({ ...entry, region: { ...entry.region, bytes, sha256: digest(bytes) } })
    }
    return classifySurfaceOwnership({ configuredHarnesses: [...new Set(entries.flatMap(entry => entry.harnesses))].sort(), entries: bound })
}

function object(value: JsonSnapshot | undefined): value is JsonSnapshotObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

function refusal(code: SurfaceDiagnostic['code'], message: string, target?: string, fix?: string): Extract<SurfaceOwnershipResult, { kind: 'refusal' }> {
    return { kind: 'refusal', diagnostic: { code, message, ...(target === undefined ? {} : { target }), ...(fix === undefined ? {} : { fix }) } }
}

function sortedUniqueStrings(value: JsonSnapshot | undefined, allowed?: ReadonlySet<string>): value is JsonSnapshot & readonly string[] {
    return Array.isArray(value) && value.length > 0 && value.every((item, index) => typeof item === 'string'
        && HARNESS.test(item) && (allowed === undefined || allowed.has(item)) && (index === 0 || value[index - 1]! < item))
}

function entryBytes(entry: SurfaceDesiredEntry): number {
    if (entry.kind === 'file') return Buffer.byteLength(entry.bytes)
    return entry.region.format === 'markdown-delimited' ? Buffer.byteLength(entry.region.bytes)
        : entry.region.members.reduce((total, member) => total + Buffer.byteLength(member.key) + Buffer.byteLength(member.valueBytes), 0)
}

function captureEntry(value: JsonSnapshot, configured: ReadonlySet<string>): SurfaceDesiredEntry | undefined {
    if (!object(value) || typeof value.kind !== 'string' || typeof value.path !== 'string' || !safePath(value.path)
        || !sortedUniqueStrings(value.harnesses, configured) || value.writer !== 'cockpit' || value.schemaVersion !== 1
        || value.scope !== 'always' && value.scope !== 'scoped' || value.capability !== 'enforced' && value.capability !== 'instructed') return undefined
    if (value.kind === 'file') {
        if (!exactKeys(value, ['kind', 'path', 'harnesses', 'scope', 'capability', 'writer', 'schemaVersion', 'ownership', 'bytes', 'sha256'])
            || value.ownership !== 'whole-file' || typeof value.bytes !== 'string' || Buffer.byteLength(value.bytes) > MAX_FILE_BYTES
            || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256) || digest(value.bytes) !== value.sha256
            || Object.hasOwn(MARKDOWN, value.path) || value.path === OPENCODE_PATH) return undefined
    } else if (value.kind === 'shared-region') {
        if (!exactKeys(value, ['kind', 'path', 'harnesses', 'scope', 'capability', 'writer', 'schemaVersion', 'ownership', 'regionId', 'region'])
            || value.ownership !== 'shared-region' || typeof value.regionId !== 'string' || !object(value.region)) return undefined
        const markdown = MARKDOWN[value.path as keyof typeof MARKDOWN]
        if (markdown) {
            if (value.regionId !== markdown.regionId || !exactKeys(value.region, ['format', 'begin', 'end', 'bytes', 'sha256'])
                || value.region.format !== 'markdown-delimited' || value.region.begin !== markdown.begin || value.region.end !== markdown.end
                || typeof value.region.bytes !== 'string' || !value.region.bytes.endsWith('\n') || Buffer.byteLength(value.region.bytes) > MAX_FILE_BYTES
                || value.region.bytes.includes(markdown.begin) || value.region.bytes.includes(markdown.end)
                || value.region.bytes.includes(OWNER_PREFIX) && markdownOwner(value.region.bytes) === undefined
                || typeof value.region.sha256 !== 'string' || digest(value.region.bytes) !== value.region.sha256) return undefined
        } else if (value.path === OPENCODE_PATH) {
            if (value.regionId !== OPENCODE_REGION && openCodeOwner(value.regionId) === undefined || !exactKeys(value.region, ['format', 'members', 'sha256'])
                || value.region.format !== 'opencode-json-root-properties' || !Array.isArray(value.region.members)
                || value.region.members.length === 0 || value.region.members.length > OPENCODE_KEYS.size) return undefined
            let priorKey = ''
            for (const member of value.region.members) {
                if (!object(member) || !exactKeys(member, ['key', 'valueBytes']) || typeof member.key !== 'string'
                    || !OPENCODE_KEYS.has(member.key) || member.key <= priorKey || typeof member.valueBytes !== 'string'
                    || Buffer.byteLength(member.valueBytes) > MAX_FILE_BYTES || tryParseJson(member.valueBytes) === undefined) return undefined
                priorKey = member.key
            }
            if (typeof value.region.sha256 !== 'string' || digest(JSON.stringify(value.region.members)) !== value.region.sha256) return undefined
        } else return undefined
    } else return undefined
    return value as unknown as SurfaceDesiredEntry
}

export function classifySurfaceOwnership(input: unknown): SurfaceOwnershipResult {
    const captured = snapshotGeneratedJson(input)
    if (!object(captured) || !exactKeys(captured, ['configuredHarnesses', 'entries']) || !sortedUniqueStrings(captured.configuredHarnesses)
        || captured.configuredHarnesses.length > SURFACE_TARGETS.length + 64
        || !Array.isArray(captured.entries) || captured.entries.length > MAX_ENTRIES) {
        return refusal('SURFACE_INPUT_INVALID', 'surface ownership input must be bounded canonical data')
    }
    const configured = new Set(captured.configuredHarnesses as readonly string[])
    const entries: SurfaceDesiredEntry[] = []
    let priorPath = ''
    let total = 0
    for (const candidate of captured.entries) {
        const entry = captureEntry(candidate, configured)
        if (!entry) return refusal('SURFACE_OWNERSHIP_INVALID', 'surface entry has an invalid path, hash, target, harness set, or ownership shape')
        if (entry.path <= priorPath) return refusal('SURFACE_PATH_CONFLICT', 'surface paths must be unique and canonically sorted', entry.path)
        priorPath = entry.path
        total += entryBytes(entry)
        if (total > MAX_TOTAL_BYTES) return refusal('SURFACE_BOUNDS', 'surface output exceeds the total byte bound')
        entries.push(entry)
    }
    const immutable = snapshotGeneratedJson({ kind: 'complete', entries })
    return immutable ? immutable as unknown as SurfaceOwnershipResult : refusal('SURFACE_BOUNDS', 'surface output cannot be captured')
}

interface RootMemberSpan { readonly key: string; readonly start: number; readonly end: number }
interface OwnerCommentSpan { readonly id: string; readonly start: number; readonly beginEnd: number; readonly endStart: number; readonly finish: number }
interface RootObject { readonly open: number; readonly members: readonly RootMemberSpan[]; readonly owner?: OwnerCommentSpan }

function maskOwnerComments(bytes: string): { readonly bytes: string; readonly owner?: OwnerCommentSpan } | undefined {
    if (!bytes.includes(OWNER_PREFIX)) return { bytes }
    const pattern = /\/\* cockpit:owner:(cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}):(start|end) \*\//g
    const matches = [...bytes.matchAll(pattern)]
    if (matches.length !== 2 || bytes.split(OWNER_PREFIX).length !== 3 || matches[0]![1] !== matches[1]![1]
        || matches[0]![2] !== 'start' || matches[1]![2] !== 'end') return undefined
    const first = matches[0]!, last = matches[1]!
    const owner = { id: first[1]!, start: first.index, beginEnd: first.index + first[0].length,
        endStart: last.index, finish: last.index + last[0].length }
    return { bytes: `${bytes.slice(0, owner.start)}${' '.repeat(first[0].length)}${bytes.slice(owner.beginEnd, owner.endStart)}${' '.repeat(last[0].length)}${bytes.slice(owner.finish)}`, owner }
}

function stringEnd(bytes: string, start: number): number | undefined {
    if (bytes[start] !== '"') return undefined
    for (let index = start + 1; index < bytes.length; index += 1) {
        const code = bytes.charCodeAt(index)
        if (code < 0x20) return undefined
        if (bytes[index] === '"') return index + 1
        if (bytes[index] === '\\') {
            index += 1
            if (index >= bytes.length) return undefined
            if (bytes[index] === 'u') {
                if (!/^[0-9a-fA-F]{4}$/.test(bytes.slice(index + 1, index + 5))) return undefined
                index += 4
            }
        }
    }
    return undefined
}

function uniqueJsonKeys(bytes: string): boolean {
    const containers: Array<{ keys?: Set<string>; expectsKey: boolean }> = []
    for (let index = 0; index < bytes.length; index += 1) {
        const char = bytes[index]
        const container = containers.at(-1)
        if (char === '"') {
            const end = stringEnd(bytes, index)
            if (end === undefined) return false
            if (container?.keys && container.expectsKey) {
                const key = tryParseJson(bytes.slice(index, end))
                if (typeof key !== 'string' || container.keys.has(key)) return false
                container.keys.add(key)
                container.expectsKey = false
            }
            index = end - 1
        } else if (char === '{') containers.push({ keys: new Set(), expectsKey: true })
        else if (char === '[') containers.push({ expectsKey: false })
        else if (char === '}' || char === ']') containers.pop()
        else if (char === ',' && container?.keys) container.expectsKey = true
    }
    return true
}

function valueEnd(bytes: string, start: number): number | undefined {
    let index = start
    let containers = 0
    while (index < bytes.length) {
        const char = bytes[index]!
        if (char === '"') {
            const end = stringEnd(bytes, index)
            if (end === undefined) return undefined
            index = end
            continue
        }
        if (containers === 0 && /\s/.test(char)) return index
        if (char === '{' || char === '[') containers += 1
        else if (char === '}' || char === ']') {
            if (containers === 0) return index
            containers -= 1
        } else if (char === ',' && containers === 0) return index
        index += 1
    }
    return undefined
}

function rootObject(original: string): RootObject | undefined {
    if (Buffer.byteLength(original) > SHARED_FILE_MAX_BYTES) return undefined
    const masked = maskOwnerComments(original)
    if (!masked) return undefined
    const { bytes, owner } = masked
    if (!object(snapshotGeneratedJson(tryParseJson(bytes))) || !uniqueJsonKeys(bytes)) return undefined
    let index = 0
    while (/\s/.test(bytes[index] ?? '')) index += 1
    if (bytes[index] !== '{') return undefined
    const open = index
    index += 1
    const members: RootMemberSpan[] = []
    const keys = new Set<string>()
    while (true) {
        while (/\s/.test(bytes[index] ?? '')) index += 1
        if (bytes[index] === '}') {
            if (owner) {
                const owned = members.filter(member => member.end <= owner.endStart)
                const last = owned.at(-1)
                if (!last || owner.start < open + 1 || bytes.slice(open + 1, owner.start).trim() !== ''
                    || bytes.slice(owner.beginEnd, members[0]!.start).trim() !== ''
                    || bytes.slice(last.end, owner.endStart).trim() !== '') return undefined
            }
            return { open, members, ...(owner ? { owner } : {}) }
        }
        const start = index
        const keyEnd = stringEnd(bytes, index)
        if (keyEnd === undefined) return undefined
        const key = tryParseJson(bytes.slice(index, keyEnd))
        if (typeof key !== 'string' || keys.has(key)) return undefined
        keys.add(key)
        index = keyEnd
        while (/\s/.test(bytes[index] ?? '')) index += 1
        if (bytes[index] !== ':') return undefined
        index += 1
        while (/\s/.test(bytes[index] ?? '')) index += 1
        const end = valueEnd(bytes, index)
        if (end === undefined) return undefined
        members.push({ key, start, end })
        index = end
        while (/\s/.test(bytes[index] ?? '')) index += 1
        if (bytes[index] === ',') { index += 1; continue }
        if (bytes[index] !== '}') return undefined
    }
}

function rootMemberValues(bytes: string): readonly OpenCodeRootMember[] | undefined {
    const lexed = rootObject(bytes)
    const masked = maskOwnerComments(bytes)
    const parsed = masked ? tryParseJson(masked.bytes) : undefined
    if (!lexed || parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    return lexed.members.map(member => ({ key: member.key, valueBytes: JSON.stringify(record[member.key]) }))
}

export function captureOpenCodeRootMembers(bytes: string): readonly OpenCodeRootMember[] | undefined {
    if (bytes.includes(OWNER_PREFIX)) return undefined
    const members = rootMemberValues(bytes)
    return members && members.every(member => OPENCODE_KEYS.has(member.key))
        ? [...members].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0) : undefined
}

function markdownPostimage(existing: string, entry: Extract<SurfaceDesiredEntry, { kind: 'shared-region' }>): SharedPostimageResult {
    if (entry.region.format !== 'markdown-delimited') return refusal('SURFACE_STATE_CONFLICT', 'Markdown path has a non-Markdown region', entry.path)
    const { begin, end, bytes } = entry.region
    const starts: number[] = []
    const finishes: number[] = []
    for (let index = existing.indexOf(begin); index >= 0; index = existing.indexOf(begin, index + begin.length)) starts.push(index)
    for (let index = existing.indexOf(end); index >= 0; index = existing.indexOf(end, index + end.length)) finishes.push(index)
    if (starts.length > 1 || finishes.length > 1 || starts.length !== finishes.length) return refusal('SURFACE_STATE_CONFLICT', 'Markdown ownership markers are partial or duplicated', entry.path)
    const block = `${begin}\n${bytes}${bytes.endsWith('\n') ? '' : '\n'}${end}`
    if (starts.length === 0) return { kind: 'complete', bytes: existing.length === 0 ? `${block}\n` : `${existing}${existing.endsWith('\n') ? '' : '\n'}${block}\n` }
    if (starts[0]! >= finishes[0]!) return refusal('SURFACE_STATE_CONFLICT', 'Markdown ownership markers are out of order', entry.path)
    return { kind: 'complete', bytes: `${existing.slice(0, starts[0])}${block}${existing.slice(finishes[0]! + end.length)}` }
}

export type SharedPostimageResult = Readonly<{ kind: 'complete'; bytes: string }>
    | Extract<SurfaceOwnershipResult, { kind: 'refusal' }>

function markdownOwnedBytes(existing: string, begin: string, end: string): { readonly start: number; readonly finish: number; readonly bytes: string } | undefined {
    const start = existing.indexOf(begin)
    const finish = existing.indexOf(end)
    if (start < 0 || finish <= start || existing.indexOf(begin, start + begin.length) >= 0 || existing.indexOf(end, finish + end.length) >= 0) return undefined
    const content = existing.slice(start + begin.length, finish)
    if (!content.startsWith('\n')) return undefined
    return { start, finish: finish + end.length, bytes: content.slice(1) }
}

function openCodeOwnedGroup(existing: string, keys: readonly string[]): {
    readonly finish: number
    readonly separatorPrefix: string
    readonly sha256: string
} | undefined {
    const parsed = rootObject(existing)
    if (!parsed || keys.length === 0 || parsed.members.length < keys.length
        || parsed.members.slice(0, keys.length).some((member, index) => member.key !== keys[index])) return undefined
    const values = rootMemberValues(existing)
    if (!values) return undefined
    const group = values.slice(0, keys.length)
    const last = parsed.members[keys.length - 1]!
    if (parsed.owner && (last.end > parsed.owner.endStart
        || parsed.members[keys.length]?.start !== undefined && parsed.members[keys.length]!.start < parsed.owner.finish)) return undefined
    const groupEnd = parsed.owner?.finish ?? last.end
    let separator = groupEnd
    while (/\s/.test(existing[separator] ?? '')) separator += 1
    let finish = groupEnd
    let separatorPrefix = ''
    if (parsed.members.length > keys.length) {
        if (existing[separator] !== ',') return undefined
        separatorPrefix = existing.slice(groupEnd, separator)
        finish = separator + 1
    }
    return { finish, separatorPrefix, sha256: digest(JSON.stringify(group)) }
}

export function renderSharedPostimage(existingBytes: string, entry: SurfaceDesiredEntry, priorOwned?: OwnershipEntry, manifest?: OwnershipManifest): SharedPostimageResult {
    const authority = manifest && issuedManifests.get(manifest)
    if (manifest && (!authority || priorOwned && !manifest.entries.some(row => sameData(row, priorOwned)))) {
        return refusal('SURFACE_OWNERSHIP_INVALID', 'shared region lacks authenticated enclosing ownership', entry.path)
    }
    if (Buffer.byteLength(existingBytes) > SHARED_FILE_MAX_BYTES || entry.kind !== 'shared-region'
        || priorOwned !== undefined && (priorOwned.kind !== 'shared-region' || priorOwned.path !== entry.path
            || priorOwned.regionId !== entry.regionId && !((priorOwned.regionId === OPENCODE_REGION || openCodeOwner(priorOwned.regionId)) && openCodeOwner(entry.regionId)))) {
        return refusal('SURFACE_STATE_CONFLICT', 'shared surface input is invalid', entry.path)
    }
    if (entry.path !== OPENCODE_PATH) {
        if (entry.region.format !== 'markdown-delimited') return refusal('SURFACE_STATE_CONFLICT', 'Markdown path has a non-Markdown region', entry.path)
        const current = markdownOwnedBytes(existingBytes, entry.region.begin, entry.region.end)
        // Bytes that match the prior record are cockpit's own under whatever id their markers carry,
        // which differs from the desired one only after `cockpit.name` was renamed.
        const recorded = current !== undefined && priorOwned?.kind === 'shared-region' && priorOwned.region.format === 'markdown-delimited'
            && digest(current.bytes) === priorOwned.region.sha256
        const expectedOwner = recorded ? markdownOwner(current.bytes) : authority?.cockpitId ?? markdownOwner(entry.region.bytes)
        if (existingBytes.includes(OWNER_PREFIX) && (!current || !markdownOwner(current.bytes)
            || existingBytes.split(OWNER_PREFIX).length !== 3 || expectedOwner !== undefined && markdownOwner(current.bytes) !== expectedOwner)) {
            return refusal('SURFACE_STATE_CONFLICT', 'Markdown owner markers are foreign or ambiguous', entry.path)
        }
        if (authority && markdownOwner(entry.region.bytes) !== authority.cockpitId) return refusal('SURFACE_OWNERSHIP_INVALID', 'desired Markdown region belongs to another cockpit', entry.path)
        if (current && (!priorOwned || priorOwned.kind !== 'shared-region' || priorOwned.region.format !== 'markdown-delimited')) {
            return refusal('SURFACE_STATE_CONFLICT', 'cockpit markers are present but the ownership record has no region for them', entry.path)
        }
        if (current && priorOwned?.kind === 'shared-region' && digest(current.bytes) !== priorOwned.region.sha256) {
            return refusal('SURFACE_STATE_CONFLICT', "the text between cockpit's markers was edited by hand since cockpit last wrote it, and sync does not overwrite hand edits", entry.path, SURFACE_HAND_EDIT_FIX)
        }
        if (!current && priorOwned) return refusal('SURFACE_STATE_CONFLICT', 'prior Markdown region is missing', entry.path)
        return markdownPostimage(existingBytes, entry)
    }
    if (entry.region.format !== 'opencode-json-root-properties') return refusal('SURFACE_STATE_CONFLICT', 'OpenCode path has a non-OpenCode region', entry.path)
    const parsed = rootObject(existingBytes)
    if (!parsed) return refusal('SURFACE_STATE_CONFLICT', 'OpenCode surface must be strict duplicate-free JSON with a root object', entry.path)
    const desiredKeys = entry.region.members.map(member => member.key)
    const desiredOwner = openCodeOwner(entry.regionId)
    // The prior record names the owner on disk; after a rename it differs from the desired one, and
    // the group digest below still has to match what cockpit last wrote.
    const priorOwner = priorOwned?.kind === 'shared-region' ? openCodeOwner(priorOwned.regionId) : undefined
    if (authority && desiredOwner !== authority.cockpitId
        || parsed.owner && (authority && parsed.owner.id !== authority.cockpitId || desiredOwner && parsed.owner.id !== (priorOwner ?? desiredOwner))
        || priorOwner && parsed.owner?.id !== priorOwner) {
        return refusal('SURFACE_STATE_CONFLICT', 'OpenCode owner markers are missing or belong to another cockpit', entry.path)
    }
    const owner = authority?.cockpitId ?? desiredOwner ?? parsed.owner?.id
    const markers = owner ? ownerMarkers(owner, 'json') : ['', '']
    const group = `${markers[0]}${entry.region.members.map(member => `${JSON.stringify(member.key)}:${member.valueBytes}`).join(',')}${markers[1]}`
    if (priorOwned === undefined) {
        if (parsed.members.some(member => desiredKeys.includes(member.key))) return refusal('SURFACE_STATE_CONFLICT', 'OpenCode root property exists without prior ownership', entry.path)
        return { kind: 'complete', bytes: `${existingBytes.slice(0, parsed.open + 1)}${group}${parsed.members.length === 0 ? '' : ','}${existingBytes.slice(parsed.open + 1)}` }
    }
    if (priorOwned.kind !== 'shared-region' || priorOwned.region.format !== 'opencode-json-root-properties') return refusal('SURFACE_STATE_CONFLICT', 'prior OpenCode ownership is invalid', entry.path)
    const prior = openCodeOwnedGroup(existingBytes, priorOwned.region.keys)
    if (!prior || prior.sha256 !== priorOwned.region.sha256) return refusal('SURFACE_STATE_CONFLICT', 'owned OpenCode root group is missing or changed', entry.path, SURFACE_HAND_EDIT_FIX)
    if (parsed.members.slice(priorOwned.region.keys.length).some(member => desiredKeys.includes(member.key))) {
        return refusal('SURFACE_STATE_CONFLICT', 'OpenCode root property exists outside prior ownership', entry.path)
    }
    const separator = parsed.members.length > priorOwned.region.keys.length ? `${prior.separatorPrefix},` : ''
    return { kind: 'complete', bytes: `${existingBytes.slice(0, parsed.open + 1)}${group}${separator}${existingBytes.slice(prior.finish)}` }
}

export function removeSharedOwnership(existingBytes: string, priorOwned: OwnershipEntry, manifest?: OwnershipManifest): SharedPostimageResult {
    const authority = manifest && issuedManifests.get(manifest)
    if (manifest && (!authority || !manifest.entries.some(row => sameData(row, priorOwned)))) return refusal('SURFACE_OWNERSHIP_INVALID', 'shared removal lacks authenticated enclosing ownership', priorOwned.path)
    if (priorOwned.kind !== 'shared-region' || Buffer.byteLength(existingBytes) > SHARED_FILE_MAX_BYTES) return refusal('SURFACE_STATE_CONFLICT', 'stale shared ownership input is invalid', priorOwned.path)
    if (priorOwned.region.format === 'markdown-delimited') {
        const current = markdownOwnedBytes(existingBytes, priorOwned.region.begin, priorOwned.region.end)
        if (existingBytes.includes(OWNER_PREFIX) && (!current || !markdownOwner(current.bytes)
            || existingBytes.split(OWNER_PREFIX).length !== 3 || authority && markdownOwner(current.bytes) !== manifest?.cockpitId)) {
            return refusal('SURFACE_STATE_CONFLICT', 'stale Markdown owner markers are foreign or ambiguous', priorOwned.path)
        }
        if (!current || digest(current.bytes) !== priorOwned.region.sha256) return refusal('SURFACE_STATE_CONFLICT', 'stale Markdown region changed', priorOwned.path, SURFACE_HAND_EDIT_FIX)
        return { kind: 'complete', bytes: `${existingBytes.slice(0, current.start)}${existingBytes.slice(current.finish)}` }
    }
    const parsed = rootObject(existingBytes)
    if (authority && parsed?.owner && parsed.owner.id !== manifest?.cockpitId
        || openCodeOwner(priorOwned.regionId) && parsed?.owner?.id !== openCodeOwner(priorOwned.regionId)) return refusal('SURFACE_STATE_CONFLICT', 'stale OpenCode owner markers are missing or foreign', priorOwned.path)
    const current = openCodeOwnedGroup(existingBytes, priorOwned.region.keys)
    if (!parsed || !current || current.sha256 !== priorOwned.region.sha256) return refusal('SURFACE_STATE_CONFLICT', 'stale OpenCode group changed', priorOwned.path, SURFACE_HAND_EDIT_FIX)
    return { kind: 'complete', bytes: `${existingBytes.slice(0, parsed.open + 1)}${current.separatorPrefix}${existingBytes.slice(current.finish)}` }
}

export type OwnershipEntry = Readonly<{ kind: 'file'; path: string; ownership: 'whole-file'; sha256: string }>
    | SurfacePriorOwnedEntry
export type EnvironmentOwnershipEntry = Readonly<{ kind: 'file'; path: string; ownership: 'whole-file'; sha256: string }>

export interface GeneratedProducer {
    readonly package: string
    readonly version: string
    readonly sourceRevision: string
}

export interface OwnershipManifestPayload {
    readonly format: 'cockpit-generated-ownership/v3'
    readonly producer: GeneratedProducer
    readonly cockpitId: string
    readonly generation: string
    readonly source: Readonly<{ path: string; sha256: string }>
    readonly personaSource: Readonly<{ path: string; sha256: string }>
    readonly entries: readonly OwnershipEntry[]
}

export interface OwnershipManifest extends OwnershipManifestPayload {
    readonly integrity: string
}


export interface OwnershipAuthority {
    readonly root: string
    readonly cockpitId: string
    readonly configPath: string
}
// No wall-clock field: the manifest is committed, and a timestamp turned every resync on another
// clone or after a repair into a team-visible diff.
export interface OwnershipManifestInput extends OwnershipAuthority {
    readonly generation: string
    readonly sourceSha256: string
    readonly personaSource: Readonly<{ path: string; sha256: string }>
    readonly owned: readonly Readonly<{ path: string; sha256: string }>[]
    readonly surfaces: readonly SurfaceDesiredEntry[]
}
const issuedManifests = new WeakMap<object, OwnershipAuthority>()
const OWNERSHIP_PATH = ".cockpit/generated-environment-ownership.json"
const MAX_OWNERSHIP_BYTES = 1_048_576
const MAX_OWNED_FILES = 256
const sha256 = digest
const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
function confinedOwnershipPath(root: string, path: string): boolean {
    const offset = relative(root, resolve(root, path))
    return offset !== "" && offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
}
export type OwnershipManifestResult = Readonly<{ kind: "complete"; manifest: OwnershipManifest }>
    | Readonly<{ kind: "invalid" }> | Readonly<{ kind: "unsupported"; format: string }>
export function parseOwnershipManifest(bytes: string, authority: OwnershipAuthority): OwnershipManifestResult {
    const fields = ownRecord(authority)
    const captured = fields && exactKeys(fields, ['root', 'cockpitId', 'configPath']) && snapshotGeneratedJson(fields)
    if (!object(captured) || typeof captured.root !== "string" || !isAbsolute(captured.root)
        || typeof captured.configPath !== "string" || dirname(captured.configPath) !== captured.root
        || typeof captured.cockpitId !== "string" || captured.cockpitId.length === 0
        || typeof bytes !== "string" || Buffer.byteLength(bytes) > MAX_OWNERSHIP_BYTES) return { kind: "invalid" }
    const record = ownRecord(tryParseJson(bytes))
    if (typeof record?.format === "string" && /^cockpit-generated-ownership\/v[0-9]+$/.test(record.format)
        && Number(record.format.slice(record.format.lastIndexOf("v") + 1)) > 3) {
        return { kind: "unsupported", format: record.format }
    }
    const manifest = parseOwnership(bytes, captured as unknown as OwnershipAuthority)
    return manifest ? { kind: "complete", manifest } : { kind: "invalid" }
}
function ownershipPayload(prepared: OwnershipManifestInput): OwnershipManifestPayload {
    const entries: OwnershipEntry[] = [
        ...prepared.owned.map(({ path, sha256: digest }) => ({ kind: 'file' as const, path, ownership: 'whole-file' as const, sha256: digest })),
        ...prepared.surfaces.map((entry): SurfacePriorOwnedEntry => {
            if (entry.kind === 'file') {
                const { bytes: _bytes, ...prior } = entry
                return prior
            }
            if (entry.region.format === 'markdown-delimited') {
                const { bytes: _bytes, ...region } = entry.region
                return { ...entry, region }
            }
            return { ...entry, region: {
                format: entry.region.format, keys: entry.region.members.map(member => member.key), sha256: entry.region.sha256,
            } }
        }),
    ].sort((left, right) => compareCodeUnits(left.path, right.path))
    return {
        format: 'cockpit-generated-ownership/v3' as const,
        cockpitId: prepared.cockpitId,
        generation: prepared.generation,
        source: { path: basename(prepared.configPath), sha256: prepared.sourceSha256 },
        personaSource: prepared.personaSource,
        producer: { package: installedPackageMetadata.name, version: installedPackageMetadata.version, sourceRevision: installedPackageMetadata.cockpitSourceRevision },
        entries,
    }
}

export function encodeOwnershipManifest(prepared: OwnershipManifestInput): Readonly<{ bytes: string; manifest: OwnershipManifest }> {
    const payload = ownershipPayload(prepared)
    const bytes = `${JSON.stringify({ ...payload, integrity: sha256(JSON.stringify(payload)) }, null, 2)}\n`
    const parsed = parseOwnershipManifest(bytes, { root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath })
    if (parsed.kind !== "complete") throw new RefusalError("generated ownership encoder received invalid authority or entries")
    return { bytes, manifest: parsed.manifest }
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Object.getOwnPropertySymbols(value).length > 0
            || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) return undefined
        return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
    } catch {
        // a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses.
        return undefined
    }
}

// Renaming `cockpit.name` changes the publication identity the ledger and every owner marker carry.
// The ledger sits at a fixed path under the configuration's own directory and names that file, so
// one recorded under another well-formed name is this cockpit's before the rename: refusing it left
// the operator nothing to do but delete the ledger and lose track of every file cockpit wrote.
// Its entries keep the id they were written under, which classification compares with the markers
// on disk; the next sync rewrites them under the new id.
function renamedPublicationId(value: unknown): boolean {
    const name = typeof value === 'string' ? /^cockpit:([a-z0-9][a-z0-9-]*):[a-f0-9]{64}$/.exec(value)?.[1] : undefined
    return name !== undefined && publicationCockpitId({ name }) === value
}

function parseOwnership(bytes: string, prepared: OwnershipAuthority): OwnershipManifest | undefined {
    if (Buffer.byteLength(bytes, 'utf8') > MAX_OWNERSHIP_BYTES) return undefined
    try {
        const record = ownRecord(JSON.parse(bytes))
        if (!uniqueJsonKeys(bytes)) return undefined
        if (!record || record.format !== 'cockpit-generated-ownership/v3'
            || !exactKeys(record, ['format', 'producer', 'cockpitId', 'generation', 'source', 'personaSource', 'entries', 'integrity'])
            || record.cockpitId !== prepared.cockpitId && !renamedPublicationId(record.cockpitId)
            || typeof record.generation !== 'string' || !SHA256.test(record.generation)
            || typeof record.integrity !== 'string' || !SHA256.test(record.integrity)
            || !Array.isArray(record.entries) || record.entries.length > MAX_OWNED_FILES) return undefined
        const source = ownRecord(record.source)
        const personaSource = ownRecord(record.personaSource)
        if (!source || !personaSource || !exactKeys(source, ['path', 'sha256']) || !exactKeys(personaSource, ['path', 'sha256'])
            || source.path !== basename(prepared.configPath) || typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)
            || typeof personaSource.path !== 'string' || typeof personaSource.sha256 !== 'string' || !SHA256.test(personaSource.sha256)) return undefined
        const producer = ownRecord(record.producer)
        if (!producer || !exactKeys(producer, ['package', 'version', 'sourceRevision'])
            || [producer.package, producer.version, producer.sourceRevision].some(value => typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u0020\u007f-\u009f]/.test(value))
            || typeof producer.package !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(producer.package)
            || typeof producer.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(producer.version)) return undefined
        const entries: OwnershipEntry[] = []
        for (const item of record.entries as unknown[]) {
            const row = ownRecord(item)
            if (!row || typeof row.path !== 'string' || !safePath(row.path) || !confinedOwnershipPath(prepared.root, row.path) || row.path === OWNERSHIP_PATH) return undefined
            if (exactKeys(row, ['kind', 'path', 'ownership', 'sha256'])) {
                if (row.kind !== 'file' || row.ownership !== 'whole-file'
                    || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) return undefined
                entries.push({ kind: 'file', path: row.path, ownership: 'whole-file', sha256: row.sha256 })
                continue
            }
            const producerKeys = ['kind', 'path', 'harnesses', 'scope', 'capability', 'writer', 'schemaVersion', 'ownership']
            const harnesses = row.harnesses
            if (!Array.isArray(harnesses) || harnesses.length === 0 || harnesses.some((value, index) => typeof value !== 'string'
                || index > 0 && String(harnesses[index - 1]) >= value) || row.scope !== 'always' && row.scope !== 'scoped'
                || row.capability !== 'enforced' && row.capability !== 'instructed' || row.writer !== 'cockpit' || row.schemaVersion !== 1) return undefined
            if (row.kind === 'file') {
                if (!exactKeys(row, [...producerKeys, 'sha256']) || row.ownership !== 'whole-file'
                    || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) return undefined
            } else if (row.kind === 'shared-region') {
                const region = ownRecord(row.region)
                if (!exactKeys(row, [...producerKeys, 'regionId', 'region']) || row.ownership !== 'shared-region'
                    || typeof row.regionId !== 'string' || !region || typeof region.sha256 !== 'string' || !SHA256.test(region.sha256)) return undefined
                if (region.format === 'markdown-delimited') {
                    if (!exactKeys(region, ['format', 'begin', 'end', 'sha256']) || typeof region.begin !== 'string' || typeof region.end !== 'string') return undefined
                } else if (region.format === 'opencode-json-root-properties') {
                    const keys = region.keys
                    if (!exactKeys(region, ['format', 'keys', 'sha256']) || !Array.isArray(keys) || keys.length === 0
                        || keys.some((key, index) => typeof key !== 'string' || index > 0 && String(keys[index - 1]) >= key)) return undefined
                } else return undefined
            } else return undefined
            entries.push(row as unknown as SurfacePriorOwnedEntry)
        }
        if (new Set(entries.map(({ path }) => path)).size !== entries.length
            || entries.some((file, index) => index > 0
                && compareCodeUnits(entries[index - 1]!.path, file.path) >= 0)) return undefined
        const rawPayload = {
            format: record.format, cockpitId: record.cockpitId as string,
            generation: record.generation, source: source as OwnershipManifestPayload['source'],
            personaSource: personaSource as OwnershipManifestPayload['personaSource'], producer, entries,
        }
        if (record.integrity !== sha256(JSON.stringify(rawPayload))) return undefined
        const payload: OwnershipManifestPayload = {
            format: record.format, producer: producer as unknown as GeneratedProducer, cockpitId: record.cockpitId as string,
            generation: record.generation, source: source as OwnershipManifestPayload['source'],
            personaSource: personaSource as OwnershipManifestPayload['personaSource'], entries,
        }
        const manifest = snapshotGeneratedJson({
            ...payload,
            entries: entries.map((entry) => entry),
            integrity: record.integrity,
        }) as unknown as OwnershipManifest | undefined
        if (!manifest) return undefined
        issuedManifests.set(manifest, Object.freeze({ root: prepared.root, cockpitId: prepared.cockpitId, configPath: prepared.configPath }))
        return manifest
    } catch {
        // an unauthenticatable manifest is refused by the caller.
        return undefined
    }
}

export type GeneratedPathProducer = 'generated-environment' | 'environment-data-plane' | 'surface-render'
export type GeneratedPathApplicability = 'declared-before-sync' | 'sibling-unavailable' | 'required-after-sync'
export type GeneratedPathDeclaration =
    | Readonly<{ producer: GeneratedPathProducer; applicability: 'declared-before-sync' | 'required-after-sync'; entry: OwnershipEntry }>
    | Readonly<{ producer: GeneratedPathProducer; applicability: 'sibling-unavailable'; path: string }>
export interface GeneratedPathFact {
    readonly path: string
    readonly authority: OwnershipAuthority & Readonly<{ generation: string; source: OwnershipManifest['source']; integrity: string }>
    readonly entry: OwnershipEntry
    readonly declaration: GeneratedPathDeclaration | null
    readonly allowsMissing: boolean
    readonly harnesses: readonly string[]
    readonly scope: SurfaceScope
    readonly ownership: SurfaceOwnership
}
export type GeneratedPathFactsResult = Readonly<{ kind: 'complete'; facts: readonly GeneratedPathFact[] }>
    | Extract<SurfaceOwnershipResult, { kind: 'refusal' }>

const issuedFacts = new WeakSet<object>()

function sameData(left: unknown, right: unknown): boolean {
    if (left === right) return true
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
    const a = Object.keys(left).sort()
    const b = Object.keys(right).sort()
    return a.length === b.length && a.every((key, index) => key === b[index]
        && sameData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

export function projectGeneratedPathFacts(
    manifest: OwnershipManifest,
    authority: OwnershipAuthority,
    declarations: unknown,
): GeneratedPathFactsResult {
    const issued = issuedManifests.get(manifest)
    const fields = ownRecord(authority)
    const expected = fields && exactKeys(fields, ['root', 'cockpitId', 'configPath']) && snapshotGeneratedJson(fields)
    if (!issued || !object(expected) || issued.root !== expected.root || issued.cockpitId !== expected.cockpitId
        || issued.configPath !== expected.configPath) return refusal('SURFACE_OWNERSHIP_INVALID', 'ownership authority was not issued for this cockpit and config')
    const captured = snapshotGeneratedJson(declarations)
    if (!Array.isArray(captured) || captured.length > MAX_ENTRIES) return refusal('SURFACE_OWNERSHIP_INVALID', 'producer declarations must be bounded canonical data')
    const byPath = new Map<string, GeneratedPathDeclaration>()
    for (const row of captured) {
        if (!object(row) || !['generated-environment', 'environment-data-plane', 'surface-render'].includes(String(row.producer))) {
            return refusal('SURFACE_OWNERSHIP_INVALID', 'producer declaration has an unknown producer')
        }
        const unavailable = row.applicability === 'sibling-unavailable'
        if (unavailable ? !exactKeys(row, ['producer', 'applicability', 'path'])
            : !exactKeys(row, ['producer', 'applicability', 'entry']) || !['declared-before-sync', 'required-after-sync'].includes(String(row.applicability))) {
            return refusal('SURFACE_OWNERSHIP_INVALID', 'producer declaration has an invalid applicability or shape')
        }
        const path = unavailable ? row.path : object(row.entry) ? row.entry.path : undefined
        if (typeof path !== 'string' || !safePath(path) || byPath.has(path)) return refusal('SURFACE_PATH_CONFLICT', 'producer declarations must have unique exact paths')
        const entry = manifest.entries.find(entry => entry.path === path)
        if (!entry || !unavailable && (!sameData(row.entry, entry)
            || (row.producer === 'surface-render') !== ('harnesses' in entry))) {
            return refusal('SURFACE_OWNERSHIP_INVALID', 'producer declaration does not match the exact manifest entry', path)
        }
        byPath.set(path, row as unknown as GeneratedPathDeclaration)
    }
    // Classification compares the owner markers on disk with the id the ledger recorded them under.
    const enclosing = { ...issued, cockpitId: manifest.cockpitId, generation: manifest.generation, source: manifest.source, integrity: manifest.integrity }
    const facts = manifest.entries.map(entry => {
        const declaration = byPath.get(entry.path) ?? null
        const fact = { path: entry.path, authority: enclosing, entry, declaration,
            allowsMissing: declaration?.applicability === 'declared-before-sync',
            harnesses: 'harnesses' in entry ? entry.harnesses : [],
            scope: 'scope' in entry ? entry.scope : 'always' as const, ownership: entry.ownership }
        issuedFacts.add(fact)
        return fact
    })
    return { kind: 'complete', facts }
}

export interface GeneratedPathClassification {
    readonly fact: GeneratedPathFact
    readonly state: 'unchanged' | 'modified' | 'unknown' | 'missing'
    readonly rawSha256?: string
    readonly diagnostics: readonly SurfaceDiagnostic[]
}

export type GeneratedPathClassificationResult = Readonly<{ kind: 'complete'; paths: readonly GeneratedPathClassification[] }>
    | Extract<SurfaceOwnershipResult, { kind: 'refusal' }>

function captureNativeBytes(input: unknown): Uint8Array | undefined {
    if (isProxy(input) || !isUint8Array(input)) return undefined
    try {
        const prototype = Object.getPrototypeOf(input)
        if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) return undefined
        const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!.call(input) as number
        if (length > SHARED_FILE_MAX_BYTES) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.length !== length || keys.some(key => typeof key !== 'string'
            || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length || !('value' in descriptors[key]!))) return undefined
        const bytes = new Uint8Array(length)
        Uint8Array.prototype.set.call(bytes, input)
        return bytes
    } catch {
        // a guard over caller-supplied values; a throwing accessor or proxy trap is malformed input the caller refuses.
        return undefined
    }
}

export function classifyGeneratedPaths(facts: readonly GeneratedPathFact[], observations: unknown): GeneratedPathClassificationResult {
    if (!Array.isArray(facts) || facts.length > MAX_ENTRIES || facts.some(fact => !issuedFacts.has(fact))
        || new Set(facts.map(fact => fact.path)).size !== facts.length) return refusal('SURFACE_OWNERSHIP_INVALID', 'classification requires unique issued ownership facts')
    if (!Array.isArray(observations) || isProxy(observations) || observations.length > MAX_ENTRIES + 1) return refusal('SURFACE_INPUT_INVALID', 'observations must be a bounded array')
    const rows = new Map<string, Record<string, unknown>>()
    for (let index = 0; index < observations.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(observations, String(index))
        const row = descriptor && !descriptor.get && !descriptor.set && ownRecord(descriptor.value)
        if (!row || typeof row.path !== 'string' || !safePath(row.path) || rows.has(row.path)) return refusal('SURFACE_INPUT_INVALID', 'observations require unique confined path names')
        rows.set(row.path, row)
    }
    const paths = facts.map((fact): GeneratedPathClassification => {
        const row = rows.get(fact.path)
        let state: GeneratedPathClassification['state'] = 'unknown'
        let rawSha256: string | undefined
        if (row?.confinement === 'confined') {
            const entry = fact.entry
            const bytes = row.kind === 'file' ? captureNativeBytes(row.bytes) : undefined
            if (row.kind === 'missing') state = 'missing'
            else if (row.kind === 'file' && typeof row.identity === 'string' && row.identity.length > 0
                && bytes !== undefined) {
                rawSha256 = digest(bytes)
                if (entry.kind === 'file') state = rawSha256 === entry.sha256 ? 'unchanged' : 'modified'
                else if (entry.kind === 'shared-region') {
                    let text: string | undefined
                    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* undecodable bytes are malformed input the caller refuses. */ state = 'unknown' }
                    if (text !== undefined && entry.region.format === 'markdown-delimited') {
                        const region = markdownOwnedBytes(text, entry.region.begin, entry.region.end)
                        const owner = region && markdownOwner(region.bytes)
                        if (region && (!text.includes(OWNER_PREFIX) || owner === fact.authority.cockpitId && text.split(OWNER_PREFIX).length === 3)) {
                            state = digest(region.bytes) === entry.region.sha256 ? 'unchanged' : 'modified'
                        } else if (!text.includes(OWNER_PREFIX) && !text.includes(entry.region.begin) && !text.includes(entry.region.end)) state = 'missing'
                    } else if (text !== undefined && entry.region.format === 'opencode-json-root-properties') {
                        const parsed = rootObject(text)
                        const group = openCodeOwnedGroup(text, entry.region.keys)
                        const expectedOwner = openCodeOwner(entry.regionId)
                        if (group && (!parsed?.owner || parsed.owner.id === fact.authority.cockpitId)
                            && (!expectedOwner || parsed?.owner?.id === expectedOwner)) state = group.sha256 === entry.region.sha256 ? 'unchanged' : 'modified'
                        else if (parsed && !parsed.owner && !parsed.members.some(member => entry.region.format === 'opencode-json-root-properties' && entry.region.keys.includes(member.key))) state = 'missing'
                    }
                }
            }
        }
        const diagnostics: readonly SurfaceDiagnostic[] = state === 'unchanged' || state === 'missing' && fact.allowsMissing ? []
            : [{ code: 'SURFACE_STATE_CONFLICT' as const, target: fact.path,
                message: state === 'unknown' ? 'cockpit could not confirm this generated path is still the plain file or link inside the cockpit root that it last wrote'
                    : state === 'missing' ? 'this generated path is missing and nothing in this sync recreates it'
                        : 'this generated file was edited by hand since cockpit last wrote it, and sync does not overwrite hand edits',
                ...(state === 'modified' ? { fix: SURFACE_HAND_EDIT_FIX } : {}) }]
        return { fact, state, ...(rawSha256 ? { rawSha256 } : {}), diagnostics }
    })
    return { kind: 'complete', paths }
}
