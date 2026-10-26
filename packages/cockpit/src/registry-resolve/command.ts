import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBoundedInput, STRUCTURED_INPUT_BYTE_LIMIT } from '../config/load.js'
import type { Diagnostic } from '../diagnostics.js'
import { parseRegistry, type DocumentedSibling, type RegistryReadResult } from '../document/registry.js'
import { renderResolvedRegistryShell } from './render-shell.js'

export const mechanism = {
    id: 'registry-resolution',
    module: 'packages/cockpit/src/registry-resolve/command.ts',
    exports: ['registryResolveCommand'],
} as const

const FORMAT_VERSION = '1'
const ADOPTION_LAYERS = ['registry', 'environment', 'surfaces', 'guards', 'grading'] as const
const packageManifest = fileURLToPath(new URL('../../package.json', import.meta.url))

type AdoptionLayer = typeof ADOPTION_LAYERS[number]
type AdoptionState = 'migrated' | 'documented-only'

interface OutcomeBase {
    artifact: string | null
    destination: null
    diagnostics: Diagnostic[]
    result: { registry: RegistryResolutionResult } | null
    status: number
}

interface RegistryResolutionResult {
    format: string
    cockpitSourceRevision: string
    registrySha256: string
    dialect: 'lane' | 'tier'
    siblingCount: number
    adoption: { layer: AdoptionLayer; state: AdoptionState }[]
}

interface ResolvedRegistryContext {
    adoption: { layer: AdoptionLayer; state: AdoptionState }[]
    cockpitSourceRevision: string
    registryPath: string
    registrySha256: string
    siblingsRoot: string
}

export interface RegistryResolveCommandInput {
    registry: string
    siblingsRoot: string
    adoption: string
    cockpitSourceRevision?: string
}

export interface CompleteRegistryResolveOutcome extends OutcomeBase {
    kind: 'complete'
    artifact: string
    result: { registry: RegistryResolutionResult }
    status: 0
}

export interface RefusedRegistryResolveOutcome extends OutcomeBase {
    kind: 'refusal'
    artifact: null
    result: null
    status: 2
}

export type RegistryResolveOutcome = CompleteRegistryResolveOutcome | RefusedRegistryResolveOutcome

function refusal(code: string, message: string, target?: string, fix?: string): RefusedRegistryResolveOutcome {
    return {
        kind: 'refusal',
        artifact: null,
        destination: null,
        diagnostics: [{ severity: 'error', code, message, target, fix }],
        result: null,
        status: 2,
    }
}

async function sourceRevision(injected?: string): Promise<string | undefined> {
    if (injected !== undefined) return injected
    try {
        const manifest = JSON.parse(await readFile(packageManifest, 'utf8')) as { cockpitSourceRevision?: unknown }
        return typeof manifest.cockpitSourceRevision === 'string' ? manifest.cockpitSourceRevision : undefined
    } catch {
        return undefined
    }
}

async function readInput(path: string, kind: 'registry' | 'adoption'): Promise<Buffer | RefusedRegistryResolveOutcome> {
    try {
        const read = await readBoundedInput(resolve(path))
        return read.kind === 'complete' ? read.bytes : refusal(
            kind === 'registry' ? 'REGISTRY_TOO_LARGE' : 'ADOPTION_TOO_LARGE',
            `the ${kind} file exceeds the ${STRUCTURED_INPUT_BYTE_LIMIT}-byte input limit`,
            resolve(path),
        )
    } catch (error) {
        const ioCode = (error as NodeJS.ErrnoException).code
        return refusal(
            ioCode === 'ENOENT'
                ? kind === 'registry' ? 'REGISTRY_NOT_FOUND' : 'ADOPTION_NOT_FOUND'
                : kind === 'registry' ? 'REGISTRY_UNREADABLE' : 'ADOPTION_UNREADABLE',
            ioCode === 'ENOENT'
                ? `the ${kind} file does not exist`
                : `the ${kind} file could not be read (${ioCode ?? 'unknown I/O error'})`,
            resolve(path),
        )
    }
}

function decodeInput(bytes: Buffer): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function encodingRefusal(kind: 'registry' | 'adoption'): RefusedRegistryResolveOutcome {
    return refusal(kind === 'registry' ? 'REGISTRY_ENCODING_INVALID' : 'ADOPTION_ENCODING_INVALID', `the ${kind} file is not valid UTF-8`)
}

function parseAdoption(source: string): { value: { layer: AdoptionLayer; state: AdoptionState }[] } | { refusal: RefusedRegistryResolveOutcome } {
    if (source.trim() === '') {
        return { refusal: refusal('ADOPTION_EMPTY', 'the adoption record is empty') }
    }
    const lines = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n')
    if (lines.length !== ADOPTION_LAYERS.length) {
        return { refusal: refusal('ADOPTION_ORDER_INVALID', 'the adoption record must contain all five layers exactly once in order') }
    }

    const adoption: { layer: AdoptionLayer; state: AdoptionState }[] = []
    for (const [index, line] of lines.entries()) {
        const match = /^([a-z]+)=(migrated|documented-only)$/.exec(line)
        if (!match) {
            const state = /^[a-z]+=(.*)$/.exec(line)?.[1]
            return {
                refusal: refusal(
                    state !== undefined && state !== 'migrated' && state !== 'documented-only'
                        ? 'ADOPTION_STATE_INVALID'
                        : 'ADOPTION_RECORD_INVALID',
                    'each adoption row must be a fixed layer=migrated or layer=documented-only assignment',
                    `adoption line ${index + 1}`,
                ),
            }
        }
        const expected = ADOPTION_LAYERS[index]
        if (match[1] !== expected) {
            return {
                refusal: refusal(
                    'ADOPTION_ORDER_INVALID',
                    'the adoption layers must appear exactly once in registry, environment, surfaces, guards, grading order',
                    `adoption line ${index + 1}`,
                ),
            }
        }
        adoption.push({ layer: expected, state: match[2] as AdoptionState })
    }

    const firstDocumented = adoption.findIndex(({ state }) => state === 'documented-only')
    const migratedAfterGap = firstDocumented !== -1 && adoption.slice(firstDocumented).some(({ state }) => state === 'migrated')
    if (adoption[0].state !== 'migrated' || migratedAfterGap) {
        return {
            refusal: refusal(
                'ADOPTION_ORDER_INVALID',
                'migration must start at registry and remain a contiguous prefix; documented-only layers may follow',
            ),
        }
    }
    return { value: adoption }
}

function compatibilityRow(sibling: DocumentedSibling, dialect: 'lane' | 'tier'): string {
    if (dialect === 'lane') {
        const lane = sibling.mount.value === 'always' ? 'app' : sibling.mount.value
        return [sibling.slug, sibling.dir, sibling.remote ?? '', lane, sibling.var, sibling.purpose].join('|')
    }
    const tier = sibling.mount.value === 'always'
        ? 'required'
        : sibling.acquire.value === 'none'
            ? 'local'
            : sibling.acquire.value
    return [
        sibling.slug,
        sibling.dir,
        sibling.remote ?? '-',
        sibling.branch ?? '-',
        tier,
        sibling.var,
        sibling.purpose,
    ].join('|')
}

function resolveRegistry(
    parsed: RegistryReadResult,
    context: ResolvedRegistryContext,
): RegistryResolveOutcome {
    if (parsed.skipped.length > 0) {
        const first = parsed.skipped[0]
        return refusal(
            first.code ?? 'REGISTRY_ROW_SKIPPED',
            first.code === 'REGISTRY_AMBIGUOUS'
                ? 'the registry structure is ambiguous'
                : 'the registry contains a row that could not be resolved safely',
            `registry line ${first.sourceLine}`,
            'repair the named source line before resolving repository scope',
        )
    }
    if (!parsed.found || !parsed.dialect || parsed.siblings.length === 0) {
        return refusal(
            parsed.found ? 'REGISTRY_EMPTY' : 'REGISTRY_NOT_FOUND',
            parsed.found ? 'the registry contains no usable rows' : 'the file contains no sibling registry',
            context.registryPath,
        )
    }

    const invalidVariable = parsed.siblings.find((sibling) => !/^[A-Z][A-Z0-9_]*_DIR$/.test(sibling.var))
    if (invalidVariable) {
        return refusal(
            'REGISTRY_VARIABLE_INVALID',
            'a sibling variable is outside the safe directory-variable namespace',
            'registry field var',
        )
    }
    const escapedDirectory = parsed.siblings.find((sibling) => {
        if (isAbsolute(sibling.dir)) return true
        const resolvedDirectory = resolve(context.siblingsRoot, sibling.dir)
        const fromRoot = relative(context.siblingsRoot, resolvedDirectory)
        return fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
    })
    if (escapedDirectory) {
        return refusal(
            'REGISTRY_DIR_OUTSIDE_SIBLINGS_ROOT',
            'a sibling directory resolves outside the declared sibling root',
            'registry field dir',
        )
    }
    const resolvedDirectories = parsed.siblings.map((sibling) => resolve(context.siblingsRoot, sibling.dir))
    if (new Set(resolvedDirectories).size !== resolvedDirectories.length) {
        return refusal(
            'REGISTRY_DIR_DUPLICATE',
            'multiple sibling rows resolve to the same directory',
            'registry field dir',
        )
    }
    const variables = parsed.siblings.map((sibling, index) => ({
        name: sibling.var,
        defaultPath: resolvedDirectories[index],
    }))
    const result: RegistryResolutionResult = {
        format: FORMAT_VERSION,
        cockpitSourceRevision: context.cockpitSourceRevision,
        registrySha256: context.registrySha256,
        dialect: parsed.dialect,
        siblingCount: parsed.siblings.length,
        adoption: context.adoption,
    }

    try {
        const artifact = renderResolvedRegistryShell({
            formatVersion: FORMAT_VERSION,
            cockpitSourceRevision: context.cockpitSourceRevision,
            registrySha256: context.registrySha256,
            dialect: parsed.dialect,
            siblingsRoot: context.siblingsRoot,
            rows: parsed.siblings.map((sibling) => compatibilityRow(sibling, parsed.dialect!)),
            paths: parsed.siblings.map((sibling, index) =>
                [variables[index].defaultPath, sibling.remote ?? '-', sibling.branch ?? '-'].join('|'),
            ),
            variables,
            adoption: context.adoption,
        })
        return { kind: 'complete', artifact, destination: null, diagnostics: [], result: { registry: result }, status: 0 }
    } catch (error) {
        const code = error instanceof Error && /^([A-Z0-9_]+):/.exec(error.message)?.[1]
        return refusal(
            code || 'REGISTRY_ARTIFACT_UNSAFE',
            'validated registry data could not be represented as a data-only shell artifact',
        )
    }
}

export async function registryResolveCommand(input: RegistryResolveCommandInput): Promise<RegistryResolveOutcome> {
    const revision = await sourceRevision(input.cockpitSourceRevision)
    if (!revision || !/^[a-f0-9]{40}$/.test(revision)) {
        return refusal(
            'COCKPIT_REVISION_INVALID',
            'the installed package does not carry an exact 40-hex cockpit source revision',
            'cockpitSourceRevision',
        )
    }

    const registryRead = await readInput(input.registry, 'registry')
    if (!Buffer.isBuffer(registryRead)) return registryRead
    let registrySource: string
    try {
        registrySource = decodeInput(registryRead)
    } catch {
        return encodingRefusal('registry')
    }
    if (registryRead.length === 0 || registrySource.trim() === '') {
        return refusal('REGISTRY_EMPTY', 'the registry file is empty', resolve(input.registry))
    }

    const adoptionRead = await readInput(input.adoption, 'adoption')
    if (!Buffer.isBuffer(adoptionRead)) return adoptionRead
    let adoptionSource: string
    try {
        adoptionSource = decodeInput(adoptionRead)
    } catch {
        return encodingRefusal('adoption')
    }
    const adoptionResult = parseAdoption(adoptionSource)
    if ('refusal' in adoptionResult) return adoptionResult.refusal

    const registrySha256 = createHash('sha256').update(registryRead).digest('hex')
    return resolveRegistry(parseRegistry(registrySource), {
        adoption: adoptionResult.value,
        cockpitSourceRevision: revision,
        registryPath: resolve(input.registry),
        registrySha256,
        siblingsRoot: resolve(input.siblingsRoot),
    })
}
