import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    fsyncSync,
    linkSync,
    lstatSync,
    openSync,
    readSync,
    realpathSync,
    unlinkSync,
    writeSync,
    type BigIntStats,
} from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { EnvironmentFile, Sibling, type EnvironmentFile as EnvironmentFileDeclaration } from '../schema.js'
import { ENVIRONMENT_CODES, OBSERVATION_REASON_BYTE_LIMIT, isCanonicalTimestamp, snapshotEnvironmentObservation, snapshotJson, type EnvironmentObservation, type JsonSnapshot, type StackId, RefusalError, hasErrorCode } from './contract.js'

export const mechanism = {
    id: 'environment-template-seeding',
    module: 'packages/cockpit/src/environment/templates.ts',
    exports: ['externalDependencyTemplateFragments', 'inspectEnvironmentKeys', 'planEnvironmentSeed', 'seedEnvironmentInstance', 'seedEnvironmentInstanceSync', 'observeSiblingPresence', 'observeEnvironmentKeys', 'observeTemplateHealth', 'isTemplateObservation', 'observationDeclarations'],
} as const

export interface ExternalEndpointRuntimeFragment {
    readonly variable: string
    readonly value: string
    readonly service: string
}

export interface ExternalEndpointTemplateFragment {
    readonly variable: string
    readonly value: string
    readonly sibling: string
    readonly template: string
}

export type ExternalDependencyTemplateFragments = Readonly<{
    kind: 'complete'
    dependencyId: string
    runtime: readonly ExternalEndpointRuntimeFragment[]
    secretsTemplate: readonly ExternalEndpointTemplateFragment[]
    nonempty: readonly Readonly<{ variable: string; value: string }>[]
    shadowFiles: readonly Readonly<{ sibling: string; instance: string }>[]
    normalizeExportedEmpties: true
    placeholder: string
}> | Readonly<{ kind: 'refusal'; reason: string }>

const DECLARATION_ID = /^[a-z0-9][a-z0-9-]*$/
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/
const PLACEHOLDER = /^cockpit:absent:[a-z0-9-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function localSink(value: unknown): value is string {
    if (typeof value !== 'string') return false
    try {
        const url = new URL(value)
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== ''
            || url.search !== '' || url.hash !== '') return false
        return url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1'
            || DECLARATION_ID.test(url.hostname)
    } catch {
        // URL parsing throws for any non-URL, which is not a local sink.
        return false
    }
}

export function externalDependencyTemplateFragments(declaration: unknown): ExternalDependencyTemplateFragments {
    if (!isRecord(declaration) || typeof declaration.id !== 'string' || !DECLARATION_ID.test(declaration.id)
        || typeof declaration.placeholder !== 'string' || !PLACEHOLDER.test(declaration.placeholder)
        || !Array.isArray(declaration.endpoints) || declaration.endpoints.length === 0) {
        return Object.freeze({ kind: 'refusal', reason: 'external dependency endpoint declaration is incomplete' })
    }
    const variables = new Set<string>()
    const runtime: ExternalEndpointRuntimeFragment[] = []
    const secretsTemplate: ExternalEndpointTemplateFragment[] = []
    for (const candidate of declaration.endpoints) {
        if (!isRecord(candidate) || typeof candidate.variable !== 'string' || !ENVIRONMENT_NAME.test(candidate.variable)
            || variables.has(candidate.variable) || !localSink(candidate.sink)
            || typeof candidate.runtime_service !== 'string' || !DECLARATION_ID.test(candidate.runtime_service)
            || !isRecord(candidate.supplier) || typeof candidate.supplier.sibling !== 'string' || !DECLARATION_ID.test(candidate.supplier.sibling)
            || typeof candidate.supplier.template !== 'string' || candidate.supplier.template.length === 0) {
            return Object.freeze({ kind: 'refusal', reason: 'external dependency endpoint pin is invalid or duplicated' })
        }
        variables.add(candidate.variable)
        runtime.push(Object.freeze({ variable: candidate.variable, value: candidate.sink, service: candidate.runtime_service }))
        secretsTemplate.push(Object.freeze({ variable: candidate.variable, value: candidate.sink, sibling: candidate.supplier.sibling, template: candidate.supplier.template }))
    }
    const shadowFiles: Readonly<{ sibling: string; instance: string }>[] = []
    if (declaration.shadow_files !== undefined) {
        if (!Array.isArray(declaration.shadow_files)) return Object.freeze({ kind: 'refusal', reason: 'external dependency shadow declaration is invalid' })
        const shadows = new Set<string>()
        for (const candidate of declaration.shadow_files) {
            if (!isRecord(candidate) || typeof candidate.sibling !== 'string' || !DECLARATION_ID.test(candidate.sibling)
                || typeof candidate.instance !== 'string' || candidate.instance.length === 0) {
                return Object.freeze({ kind: 'refusal', reason: 'external dependency shadow declaration is invalid' })
            }
            const identity = `${candidate.sibling}\0${candidate.instance}`
            if (shadows.has(identity)) return Object.freeze({ kind: 'refusal', reason: 'external dependency shadow declaration is duplicated' })
            shadows.add(identity)
            shadowFiles.push(Object.freeze({ sibling: candidate.sibling, instance: candidate.instance }))
        }
    }
    const nonempty: Readonly<{ variable: string; value: string }>[] = []
    if (declaration.nonempty_variables !== undefined) {
        if (!Array.isArray(declaration.nonempty_variables)) return Object.freeze({ kind: 'refusal', reason: 'external dependency nonempty declaration is invalid' })
        const names = new Set<string>()
        for (const variable of declaration.nonempty_variables) {
            if (typeof variable !== 'string' || !ENVIRONMENT_NAME.test(variable) || variables.has(variable) || names.has(variable)) {
                return Object.freeze({ kind: 'refusal', reason: 'external dependency nonempty declaration is invalid or duplicated' })
            }
            names.add(variable)
            nonempty.push(Object.freeze({ variable, value: declaration.placeholder }))
        }
    }
    return Object.freeze({
        kind: 'complete', dependencyId: declaration.id,
        runtime: Object.freeze(runtime), secretsTemplate: Object.freeze(secretsTemplate), shadowFiles: Object.freeze(shadowFiles),
        nonempty: Object.freeze(nonempty), normalizeExportedEmpties: true, placeholder: declaration.placeholder,
    })
}

export const observationDeclarations = Object.freeze([
    { id: 'environment-key-freshness', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.ENVIRONMENT_KEYS_STALE, isIssued: isTemplateObservation, issuedAt: observationIssuedAt },
    { id: 'secret-file-presence', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_NOT_FOUND, isIssued: isTemplateObservation, issuedAt: observationIssuedAt },
    { id: 'sibling-presence', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.SIBLING_MISSING, isIssued: isTemplateObservation, issuedAt: observationIssuedAt },
] as const)

const issuedObservations = new WeakMap<object, number>()

function issueObservation(value: EnvironmentObservation): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== mechanism.id) throw new RefusalError('template observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    return snapshot
}

export function isTemplateObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedObservations.has(value)
}

function observationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedObservations.get(value) : undefined
}

export async function observeSiblingPresence(input: { readonly stackId: StackId; readonly observedAt: string; readonly siblingRoot: string; readonly sibling: unknown }): Promise<EnvironmentObservation> {
    const snapshot = snapshotJson(input)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new RefusalError('sibling presence input is malformed')
    const owned = snapshot as Readonly<Record<string, JsonSnapshot>>
    const sibling = Sibling.safeParse(owned.sibling)
    if (typeof owned.stackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(owned.stackId)
        || typeof owned.observedAt !== 'string' || !isCanonicalTimestamp(owned.observedAt)
        || typeof owned.siblingRoot !== 'string' || !isAbsolute(owned.siblingRoot)
        || normalize(owned.siblingRoot) !== owned.siblingRoot || !sibling.success) throw new RefusalError('sibling presence input is malformed')
    const path = resolve(owned.siblingRoot, sibling.data.dir)
    const confined = relative(owned.siblingRoot, path)
    if (confined === '..' || confined.startsWith(`..${sep}`) || isAbsolute(confined)) throw new RefusalError('sibling presence input is malformed')
    let present = false
    try {
        const status = await lstat(path)
        present = status.isDirectory() && !status.isSymbolicLink()
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw new RefusalError('sibling presence could not be observed')
    }
    return issueObservation({ code: ENVIRONMENT_CODES.SIBLING_MISSING, owner: mechanism.id, stackId: owned.stackId as StackId, source: path,
        observed: { state: 'available', value: present, observedAt: owned.observedAt }, expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'environment' }, freshness: { state: 'current' }, remedy: 'restore the declared sibling checkout' })
}

const DEFAULT_MAX_BYTES = 1024 * 1024
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

type EnvironmentFileSide = 'template' | 'instance'
type InspectionCode =
    | typeof ENVIRONMENT_CODES.ENVIRONMENT_FILE_NOT_FOUND
    | typeof ENVIRONMENT_CODES.ENVIRONMENT_FILE_UNREADABLE
    | typeof ENVIRONMENT_CODES.ENVIRONMENT_FILE_TOO_LARGE
    | typeof ENVIRONMENT_CODES.ENVIRONMENT_FILE_MALFORMED
    | typeof ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT

export type EnvironmentKeyInspection =
    | {
          kind: 'fresh' | 'stale' | 'absent'
          templatePath: string
          instancePath: string
          requiredKeys: readonly string[]
          presentKeys: readonly string[]
          missingKeys: readonly string[]
          unexpectedKeys: readonly string[]
      }
    | {
          kind: 'unreadable'
          file: EnvironmentFileSide
          path: string
          code: Exclude<InspectionCode, typeof ENVIRONMENT_CODES.ENVIRONMENT_FILE_MALFORMED>
      }
    | {
          kind: 'malformed'
          file: EnvironmentFileSide
          path: string
          line: number
          code: typeof ENVIRONMENT_CODES.ENVIRONMENT_FILE_MALFORMED
      }

interface KeyProjection {
    kind: 'keys'
    keys: readonly string[]
}

type ProjectionFailure =
    | {
          kind: 'unreadable'
          code: Exclude<InspectionCode, typeof ENVIRONMENT_CODES.ENVIRONMENT_FILE_MALFORMED>
      }
    | {
          kind: 'malformed'
          code: typeof ENVIRONMENT_CODES.ENVIRONMENT_FILE_MALFORMED
          line: number
      }

function projectAssignment(leftHandSide: string): string | null {
    let candidate = leftHandSide.trim()
    if (candidate.startsWith('export ')) candidate = candidate.slice('export '.length).trim()
    return ENVIRONMENT_KEY.test(candidate) ? candidate : null
}

async function projectKeys(root: string, path: string, maxBytes: number): Promise<KeyProjection | ProjectionFailure> {
    const keys = new Set<string>()
    let bytesRead = 0
    let line = 1
    let leftHandSide = ''
    let assignment = false
    let ignoredLine = false

    function finishLine(): ProjectionFailure | undefined {
        const candidate = leftHandSide.endsWith('\r') ? leftHandSide.slice(0, -1) : leftHandSide
        const trimmed = candidate.trim()
        if (!assignment && !ignoredLine && trimmed !== '' && !trimmed.startsWith('#')) {
            return { kind: 'malformed', code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_MALFORMED, line }
        }
        if (assignment) {
            const key = projectAssignment(candidate)
            if (key === null || keys.has(key)) {
                return { kind: 'malformed', code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_MALFORMED, line }
            }
            keys.add(key)
        }
        line += 1
        leftHandSide = ''
        assignment = false
        ignoredLine = false
        return undefined
    }

    let handle: Awaited<ReturnType<typeof open>>
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return {
            kind: 'unreadable',
            code:
                code === 'ENOENT'
                    ? ENVIRONMENT_CODES.ENVIRONMENT_FILE_NOT_FOUND
                    : ENVIRONMENT_CODES.ENVIRONMENT_FILE_UNREADABLE,
        }
    }

    try {
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile()) return { kind: 'unreadable', code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_UNREADABLE }
        if (opened.size > BigInt(maxBytes)) {
            return { kind: 'unreadable', code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_TOO_LARGE }
        }
        const canonicalPath = await realpath(path)
        const named = await lstat(path, { bigint: true })
        if (
            named.isSymbolicLink() ||
            named.dev !== opened.dev ||
            named.ino !== opened.ino ||
            !isContained(root, canonicalPath)
        ) {
            return { kind: 'unreadable', code: ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT }
        }

        const buffer = Buffer.allocUnsafe(64 * 1024)
        while (true) {
            const { bytesRead: count } = await handle.read(buffer, 0, buffer.byteLength, null)
            if (count === 0) break
            bytesRead += count
            if (bytesRead > maxBytes) {
                return { kind: 'unreadable', code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_TOO_LARGE }
            }
            for (let index = 0; index < count; index += 1) {
                const byte = buffer[index]!
                if (byte === 0x0a) {
                    const failure = finishLine()
                    if (failure) return failure
                } else if (!assignment && !ignoredLine && byte === 0x3d) {
                    if (leftHandSide.trim().startsWith('#')) ignoredLine = true
                    else assignment = true
                } else if (!assignment && !ignoredLine) {
                    leftHandSide += String.fromCharCode(byte)
                }
            }
        }
    } catch (error) {
        // The unreadable result carries a code, not a cause, because read errors echo environment-file paths.
        return { kind: 'unreadable', code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_UNREADABLE }
    } finally {
        await handle.close()
    }

    if (leftHandSide !== '' || assignment || ignoredLine) {
        const failure = finishLine()
        if (failure) return failure
    }
    return { kind: 'keys', keys: [...keys].sort() }
}

export async function inspectEnvironmentKeys(input: {
    siblingRoot: string
    templatePath: string
    instancePath: string
    maxBytes?: number
}): Promise<EnvironmentKeyInspection> {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        return {
            kind: 'unreadable',
            file: 'template',
            path: input.templatePath,
            code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_TOO_LARGE,
        }
    }

    let canonicalRoot: string
    try {
        const root = await lstat(input.siblingRoot, { bigint: true })
        if (root.isSymbolicLink() || !root.isDirectory()) throw new RefusalError('invalid root')
        canonicalRoot = await realpath(input.siblingRoot)
    } catch {
        // The unreadable result carries the template-path code, not a cause.
        return {
            kind: 'unreadable',
            file: 'template',
            path: input.templatePath,
            code: ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT,
        }
    }

    const template = await projectKeys(canonicalRoot, input.templatePath, maxBytes)
    if (template.kind !== 'keys') {
        return template.kind === 'malformed'
            ? {
                  kind: 'malformed',
                  file: 'template',
                  path: input.templatePath,
                  line: template.line,
                  code: template.code,
              }
            : { kind: 'unreadable', file: 'template', path: input.templatePath, code: template.code }
    }

    const instance = await projectKeys(canonicalRoot, input.instancePath, maxBytes)
    if (instance.kind === 'unreadable' && instance.code === ENVIRONMENT_CODES.ENVIRONMENT_FILE_NOT_FOUND) {
        return {
            kind: 'absent',
            templatePath: input.templatePath,
            instancePath: input.instancePath,
            requiredKeys: template.keys,
            presentKeys: [],
            missingKeys: template.keys,
            unexpectedKeys: [],
        }
    }
    if (instance.kind !== 'keys') {
        return instance.kind === 'malformed'
            ? {
                  kind: 'malformed',
                  file: 'instance',
                  path: input.instancePath,
                  line: instance.line,
                  code: instance.code,
              }
            : { kind: 'unreadable', file: 'instance', path: input.instancePath, code: instance.code }
    }

    const present = new Set(instance.keys)
    const required = new Set(template.keys)
    const missingKeys = template.keys.filter((key) => !present.has(key))
    const unexpectedKeys = instance.keys.filter((key) => !required.has(key))
    return {
        kind: missingKeys.length === 0 && unexpectedKeys.length === 0 ? 'fresh' : 'stale',
        templatePath: input.templatePath,
        instancePath: input.instancePath,
        requiredKeys: template.keys,
        presentKeys: instance.keys,
        missingKeys,
        unexpectedKeys,
    }
}

export async function observeEnvironmentKeys(input: {
    readonly stackId: StackId
    readonly observedAt: string
    readonly siblingRoot: string
    readonly declaration: unknown
}): Promise<readonly EnvironmentObservation[]> {
    const snapshot = snapshotJson(input)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new RefusalError('environment-key observation input is malformed')
    const owned = snapshot as Readonly<Record<string, JsonSnapshot>>
    const declaration = EnvironmentFile.safeParse(owned.declaration)
    if (!declaration.success || typeof owned.stackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(owned.stackId)
        || typeof owned.observedAt !== 'string' || !isCanonicalTimestamp(owned.observedAt) || typeof owned.siblingRoot !== 'string') {
        throw new RefusalError('environment-key observation input is malformed')
    }
    const inspection = await inspectEnvironmentKeys({
        siblingRoot: owned.siblingRoot,
        templatePath: resolve(owned.siblingRoot, declaration.data.template),
        instancePath: resolve(owned.siblingRoot, declaration.data.instance),
    })
    const source = inspection.kind === 'unreadable' || inspection.kind === 'malformed' ? inspection.path : inspection.instancePath
    const presence = inspection.kind !== 'absent' && !(inspection.kind === 'unreadable' && inspection.file === 'instance')
    const fresh = inspection.kind === 'fresh'
    return Object.freeze([
        issueObservation({
            code: ENVIRONMENT_CODES.ENVIRONMENT_KEYS_STALE, owner: mechanism.id, stackId: owned.stackId as StackId, source,
            observed: inspection.kind === 'unreadable' || inspection.kind === 'malformed'
                ? { state: 'failed', reason: `${inspection.file} environment file could not be projected`, observedAt: owned.observedAt }
                : { state: 'available', value: fresh, observedAt: owned.observedAt },
            expectation: { kind: 'equal', value: true }, applicability: { state: 'required', posture: 'environment' }, freshness: { state: 'current' },
            remedy: 'synchronize the instance key names with its tracked template',
        }),
        issueObservation({
            code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_NOT_FOUND, owner: mechanism.id, stackId: owned.stackId as StackId, source,
            observed: { state: 'available', value: presence, observedAt: owned.observedAt }, expectation: { kind: 'equal', value: true },
            applicability: { state: 'required', posture: 'environment' }, freshness: { state: 'current' }, remedy: 'seed the missing environment instance from its tracked template',
        }),
    ])
}

/** Health admits one row per code; aggregate here so every declaration retains owner-issued evidence. */
export async function observeTemplateHealth(input: {
    readonly stackId: StackId
    readonly observedAt: string
    readonly siblingRoot: string
    readonly siblings: readonly unknown[]
}): Promise<readonly EnvironmentObservation[]> {
    const groups = new Map<string, EnvironmentObservation[]>()
    let environmentFileCount = 0
    const add = (observation: EnvironmentObservation) => {
        const group = groups.get(observation.code) ?? []
        group.push(observation)
        groups.set(observation.code, group)
    }
    for (const value of input.siblings) {
        const sibling = Sibling.parse(value)
        add(await observeSiblingPresence({ stackId: input.stackId, observedAt: input.observedAt,
            siblingRoot: input.siblingRoot, sibling }))
        for (const declaration of sibling.environment_files ?? []) {
            environmentFileCount += 1
            const observations = await observeEnvironmentKeys({ stackId: input.stackId, observedAt: input.observedAt,
                siblingRoot: resolve(input.siblingRoot, sibling.dir), declaration })
            observations.forEach(add)
        }
    }
    if (environmentFileCount === 0) {
        add(issueObservation({
            code: ENVIRONMENT_CODES.ENVIRONMENT_KEYS_STALE, owner: mechanism.id, stackId: input.stackId,
            source: input.siblingRoot, observed: { state: 'available', value: true, observedAt: input.observedAt },
            expectation: { kind: 'equal', value: true }, applicability: { state: 'required', posture: 'environment' },
            freshness: { state: 'current' }, remedy: 'synchronize the instance key names with its tracked template',
        }))
        add(issueObservation({
            code: ENVIRONMENT_CODES.ENVIRONMENT_FILE_NOT_FOUND, owner: mechanism.id, stackId: input.stackId,
            source: input.siblingRoot, observed: { state: 'available', value: true, observedAt: input.observedAt },
            expectation: { kind: 'equal', value: true }, applicability: { state: 'required', posture: 'environment' },
            freshness: { state: 'current' }, remedy: 'seed the missing environment instance from its tracked template',
        }))
    }
    return Object.freeze([...groups.values()].map(group => {
        if (group.length === 1) return group[0]!
        const failures = group.filter(row => row.observed.state !== 'available' || row.observed.value !== true)
        const unreadable = failures.filter(row => row.observed.state !== 'available')
        const bounded = (value: string) => Buffer.byteLength(value) <= OBSERVATION_REASON_BYTE_LIMIT ? value
            : `${Buffer.from(value).subarray(0, OBSERVATION_REASON_BYTE_LIMIT - 3).toString('utf8').replace(/�$/, '')}...`
        return issueObservation({
            ...group[0]!,
            source: bounded((failures.length > 0 ? failures : group).map(row => row.source).join('; ')),
            observed: unreadable.length > 0
                ? { state: 'failed', reason: bounded(unreadable.map(row => `${row.source}: ${row.observed.state === 'available' ? '' : row.observed.reason}`).join('; ')), observedAt: input.observedAt }
                : { state: 'available', value: failures.length === 0, observedAt: input.observedAt },
        })
    }))
}

interface FileIdentity {
    dev: string
    ino: string
    mode: string
    size: string
    mtimeNs: string
    ctimeNs: string
}

export type EnvironmentSeedPlan =
    | { kind: 'none' }
    | { kind: 'unchanged'; siblingRoot: string; destination: string }
    | { kind: 'refusal'; code: SeedRefusalCode; path: string }
    | {
          kind: 'ready'
          siblingRoot: string
          canonicalRoot: string
          source: string
          destination: string
          rootIdentity: FileIdentity
          sourceIdentity: FileIdentity
          destinationParentIdentity: FileIdentity
      }

type SeedRefusalCode =
    | typeof ENVIRONMENT_CODES.TEMPLATE_NOT_FOUND
    | typeof ENVIRONMENT_CODES.TEMPLATE_NOT_TRACKED
    | typeof ENVIRONMENT_CODES.TEMPLATE_IGNORED
    | typeof ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT
    | typeof ENVIRONMENT_CODES.INSTANCE_NOT_IGNORED
    | typeof ENVIRONMENT_CODES.ENVIRONMENT_SEED_PRECONDITION_CHANGED
    | typeof ENVIRONMENT_CODES.ENVIRONMENT_SEED_FAILED

export type EnvironmentSeedResult =
    | { kind: 'none' }
    | { kind: 'created' | 'unchanged'; siblingRoot: string; destination: string }
    | { kind: 'refusal'; code: SeedRefusalCode; path: string }

function identityOf(stat: BigIntStats): FileIdentity {
    return {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: stat.mode.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
    }
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    )
}

function sameNode(left: FileIdentity, right: FileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

function isContained(root: string, candidate: string): boolean {
    const path = relative(root, candidate)
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function secureIdentity(path: string): Promise<{
    identity: FileIdentity
    directory: boolean
    file: boolean
    symbolicLink: boolean
}> {
    const stat = await lstat(path, { bigint: true })
    return {
        identity: identityOf(stat),
        directory: stat.isDirectory(),
        file: stat.isFile(),
        symbolicLink: stat.isSymbolicLink(),
    }
}

async function hasSafeComponents(root: string, relativePath: string, includeLeaf: boolean): Promise<boolean> {
    const parts = relativePath.split('/')
    const limit = includeLeaf ? parts.length : parts.length - 1
    let current = root
    for (let index = 0; index < limit; index += 1) {
        current = join(current, parts[index]!)
        try {
            const component = await secureIdentity(current)
            if (component.symbolicLink || (index < limit - 1 && !component.directory)) return false
            const canonical = await realpath(current)
            if (!isContained(root, canonical)) return false
        } catch {
            // Any filesystem failure on a component means it is not safely contained; the caller refuses the path.
            return false
        }
    }
    return true
}

function refusal(code: SeedRefusalCode, path: string): EnvironmentSeedPlan & { kind: 'refusal' } {
    return { kind: 'refusal', code, path }
}

export async function planEnvironmentSeed(input: {
    siblingRoot: string
    environmentFile?: EnvironmentFileDeclaration
}): Promise<EnvironmentSeedPlan> {
    if (input.environmentFile === undefined) return { kind: 'none' }

    const declaration = EnvironmentFile.safeParse(input.environmentFile)
    if (!declaration.success) return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, input.siblingRoot)
    let root: Awaited<ReturnType<typeof secureIdentity>>
    let canonicalRoot: string
    try {
        root = await secureIdentity(input.siblingRoot)
        canonicalRoot = await realpath(input.siblingRoot)
    } catch {
        // The refusal carries a code and path, not a cause.
        return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, input.siblingRoot)
    }
    if (root.symbolicLink || !root.directory) {
        return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, input.siblingRoot)
    }
    if (typeof process.getuid === 'function') {
        const rootStat = await lstat(input.siblingRoot, { bigint: true })
        if (rootStat.uid !== BigInt(process.getuid())) {
            return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, input.siblingRoot)
        }
    }

    const source = resolve(canonicalRoot, declaration.data.template)
    const destination = resolve(canonicalRoot, declaration.data.instance)
    if (!isContained(canonicalRoot, source) || !isContained(canonicalRoot, destination) || source === destination) {
        return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, destination)
    }
    if (!(await hasSafeComponents(canonicalRoot, declaration.data.template, true))) {
        return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, source)
    }
    if (!(await hasSafeComponents(canonicalRoot, declaration.data.instance, false))) {
        return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, destination)
    }

    let sourceState: Awaited<ReturnType<typeof secureIdentity>>
    let parentState: Awaited<ReturnType<typeof secureIdentity>>
    try {
        sourceState = await secureIdentity(source)
    } catch {
        // The refusal carries a code and path, not a cause.
        return refusal(ENVIRONMENT_CODES.TEMPLATE_NOT_FOUND, source)
    }
    try {
        parentState = await secureIdentity(dirname(destination))
    } catch {
        // The refusal carries a code and path, not a cause.
        return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, destination)
    }
    if (sourceState.symbolicLink || !sourceState.file || parentState.symbolicLink || !parentState.directory) {
        return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, source)
    }
    try {
        if (
            !isContained(canonicalRoot, await realpath(source)) ||
            !isContained(canonicalRoot, await realpath(dirname(destination)))
        ) {
            return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, source)
        }
    } catch {
        // The refusal carries a code and path, not a cause.
        return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, source)
    }

    try {
        const destinationState = await secureIdentity(destination)
        if (destinationState.symbolicLink || !destinationState.file) {
            return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, destination)
        }
        if (
            destinationState.identity.dev === sourceState.identity.dev &&
            destinationState.identity.ino === sourceState.identity.ino
        ) {
            return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, destination)
        }
        return { kind: 'unchanged', siblingRoot: input.siblingRoot, destination }
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
            return refusal(ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT, destination)
        }
    }

    return {
        kind: 'ready',
        siblingRoot: input.siblingRoot,
        canonicalRoot,
        source,
        destination,
        rootIdentity: root.identity,
        sourceIdentity: sourceState.identity,
        destinationParentIdentity: parentState.identity,
    }
}

function revalidatePlan(
    plan: EnvironmentSeedPlan & { kind: 'ready' },
):
    | typeof ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT
    | typeof ENVIRONMENT_CODES.ENVIRONMENT_SEED_PRECONDITION_CHANGED
    | undefined
{
    try {
        const rootStat = lstatSync(plan.canonicalRoot, { bigint: true })
        const sourceStat = lstatSync(plan.source, { bigint: true })
        const parentStat = lstatSync(dirname(plan.destination), { bigint: true })
        const root = { identity: identityOf(rootStat), directory: rootStat.isDirectory(), symbolicLink: rootStat.isSymbolicLink() }
        const source = { identity: identityOf(sourceStat), file: sourceStat.isFile(), symbolicLink: sourceStat.isSymbolicLink() }
        const parent = { identity: identityOf(parentStat), directory: parentStat.isDirectory(), symbolicLink: parentStat.isSymbolicLink() }
        const structurallySafe =
            !root.symbolicLink &&
            root.directory &&
            !source.symbolicLink &&
            source.file &&
            !parent.symbolicLink &&
            parent.directory &&
            sameNode(root.identity, plan.rootIdentity) &&
            sameNode(parent.identity, plan.destinationParentIdentity) &&
            isContained(plan.canonicalRoot, realpathSync(plan.source)) &&
            isContained(plan.canonicalRoot, realpathSync(dirname(plan.destination)))
        if (!structurallySafe) return ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT
        // A regular template replaced inside the root is a changed precondition like an in-place
        // rewrite, whatever inode it lands on: ext4 often reuses the one just freed, APFS does not.
        return identitiesMatch(source.identity, plan.sourceIdentity)
            ? undefined
            : ENVIRONMENT_CODES.ENVIRONMENT_SEED_PRECONDITION_CHANGED
    } catch {
        // Any filesystem failure while rechecking means the paths are no longer provably inside the root.
        return ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT
    }
}

function seedFromPinnedDirectory(plan: EnvironmentSeedPlan & { kind: 'ready' }): EnvironmentSeedResult {
    const destinationDirectory = dirname(plan.destination)
    const destinationName = basename(plan.destination)
    const temporaryName = `.${destinationName}.cockpit-seed-${randomUUID()}`
    const originalDirectory = process.cwd()
    let sourceDescriptor: number | undefined
    let temporaryDescriptor: number | undefined
    let temporaryCreated = false
    let result: EnvironmentSeedResult = {
        kind: 'refusal',
        code: ENVIRONMENT_CODES.ENVIRONMENT_SEED_FAILED,
        path: plan.destination,
    }

    try {
        process.chdir(destinationDirectory)
        const pinnedDirectory = realpathSync('.')
        const declaredDirectory = realpathSync(destinationDirectory)
        const pinnedState = lstatSync('.', { bigint: true })
        if (
            pinnedDirectory !== declaredDirectory ||
            !isContained(plan.canonicalRoot, pinnedDirectory) ||
            !pinnedState.isDirectory() ||
            !sameNode(identityOf(pinnedState), plan.destinationParentIdentity)
        ) {
            result = {
                kind: 'refusal',
                code: ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT,
                path: plan.destination,
            }
        } else {
            sourceDescriptor = openSync(
                plan.source,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            )
            const sourceBefore = identityOf(fstatSync(sourceDescriptor, { bigint: true }))
            const namedSource = lstatSync(plan.source, { bigint: true })
            if (
                namedSource.isSymbolicLink() ||
                !namedSource.isFile() ||
                !identitiesMatch(sourceBefore, plan.sourceIdentity) ||
                namedSource.dev !== BigInt(sourceBefore.dev) ||
                namedSource.ino !== BigInt(sourceBefore.ino) ||
                !isContained(plan.canonicalRoot, realpathSync(plan.source))
            ) {
                result = {
                    kind: 'refusal',
                    code: ENVIRONMENT_CODES.ENVIRONMENT_SEED_PRECONDITION_CHANGED,
                    path: plan.source,
                }
            } else {
                temporaryDescriptor = openSync(
                    temporaryName,
                    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                    0o600,
                )
                temporaryCreated = true
                const buffer = Buffer.allocUnsafe(64 * 1024)
                while (true) {
                    const count = readSync(sourceDescriptor, buffer, 0, buffer.byteLength, null)
                    if (count === 0) break
                    let offset = 0
                    while (offset < count) offset += writeSync(temporaryDescriptor, buffer, offset, count - offset)
                }
                fchmodSync(temporaryDescriptor, 0o600)
                fsyncSync(temporaryDescriptor)

                if (!identitiesMatch(identityOf(fstatSync(sourceDescriptor, { bigint: true })), plan.sourceIdentity)) {
                    result = {
                        kind: 'refusal',
                        code: ENVIRONMENT_CODES.ENVIRONMENT_SEED_PRECONDITION_CHANGED,
                        path: plan.source,
                    }
                } else if (
                    realpathSync(destinationDirectory) !== pinnedDirectory ||
                    !sameNode(identityOf(lstatSync('.', { bigint: true })), plan.destinationParentIdentity)
                ) {
                    result = {
                        kind: 'refusal',
                        code: ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT,
                        path: plan.destination,
                    }
                } else {
                    try {
                        linkSync(temporaryName, destinationName)
                        const temporaryState = lstatSync(temporaryName, { bigint: true })
                        const destinationState = lstatSync(destinationName, { bigint: true })
                        result =
                            destinationState.isFile() &&
                            destinationState.dev === temporaryState.dev &&
                            destinationState.ino === temporaryState.ino
                                ? { kind: 'created', siblingRoot: plan.siblingRoot, destination: plan.destination }
                                : {
                                      kind: 'refusal',
                                      code: ENVIRONMENT_CODES.ENVIRONMENT_SEED_FAILED,
                                      path: plan.destination,
                                  }
                    } catch (error) {
                        if (!hasErrorCode(error, 'EEXIST')) {
                            result = {
                                kind: 'refusal',
                                code: ENVIRONMENT_CODES.ENVIRONMENT_SEED_FAILED,
                                path: plan.destination,
                            }
                        } else {
                            let destinationDescriptor: number | undefined
                            try {
                                const namedDestination = lstatSync(destinationName, { bigint: true })
                                destinationDescriptor = openSync(
                                    destinationName,
                                    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                                )
                                const openedDestination = fstatSync(destinationDescriptor, { bigint: true })
                                const sameDestination =
                                    namedDestination.dev === openedDestination.dev &&
                                    namedDestination.ino === openedDestination.ino
                                const aliasesSource =
                                    openedDestination.dev === BigInt(sourceBefore.dev) &&
                                    openedDestination.ino === BigInt(sourceBefore.ino)
                                result =
                                    namedDestination.isFile() &&
                                    openedDestination.isFile() &&
                                    sameDestination &&
                                    !aliasesSource
                                        ? {
                                              kind: 'unchanged',
                                              siblingRoot: plan.siblingRoot,
                                              destination: plan.destination,
                                          }
                                        : {
                                              kind: 'refusal',
                                              code: ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT,
                                              path: plan.destination,
                                          }
                            } catch {
                                // The refusal carries a code and path, not a cause.
                                result = {
                                    kind: 'refusal',
                                    code: ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT,
                                    path: plan.destination,
                                }
                            } finally {
                                if (destinationDescriptor !== undefined) closeSync(destinationDescriptor)
                            }
                        }
                    }
                }
            }
        }
    } catch {
        // The refusal carries a code and path, not a cause.
        result = {
            kind: 'refusal',
            code: ENVIRONMENT_CODES.ENVIRONMENT_SEED_FAILED,
            path: plan.destination,
        }
    } finally {
        if (temporaryDescriptor !== undefined) closeSync(temporaryDescriptor)
        if (sourceDescriptor !== undefined) closeSync(sourceDescriptor)
        if (temporaryCreated) {
            try {
                unlinkSync(temporaryName)
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) {
                    result = {
                        kind: 'refusal',
                        code: ENVIRONMENT_CODES.ENVIRONMENT_SEED_FAILED,
                        path: plan.destination,
                    }
                }
            }
        }
        process.chdir(originalDirectory)
    }
    return result
}

export function seedEnvironmentInstanceSync(plan: EnvironmentSeedPlan): EnvironmentSeedResult {
    if (plan.kind !== 'ready') return plan
    const invalidPlan = revalidatePlan(plan)
    if (invalidPlan !== undefined) {
        return {
            kind: 'refusal',
            code: invalidPlan,
            path: invalidPlan === ENVIRONMENT_CODES.ENVIRONMENT_SEED_PRECONDITION_CHANGED
                ? plan.source
                : plan.destination,
        }
    }
    return seedFromPinnedDirectory(plan)
}

export async function seedEnvironmentInstance(plan: EnvironmentSeedPlan): Promise<EnvironmentSeedResult> {
    return seedEnvironmentInstanceSync(plan)
}
