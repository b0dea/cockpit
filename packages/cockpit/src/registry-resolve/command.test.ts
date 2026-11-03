import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registryResolveCommand } from './command.js'

const revision = '0123456789abcdef0123456789abcdef01234567'
const scratch: string[] = []
const registryBytes = Buffer.from([
    'SYNTHETIC_SIBLINGS=(',
    '  "api|api-service|ssh://example.invalid/api.git|main|required|API_DIR|Primary API"',
    '  "web|web-app|ssh://example.invalid/web.git|develop|auto|WEB_DIR|EXTRA_PROFILES=web optional UI"',
    '  "notes|notes-data|-|-|local|NOTES_DIR|Read-only fixtures"',
    ')',
    '',
].join('\n'))
const adoptionBytes = Buffer.from([
    'registry=migrated',
    'environment=documented-only',
    'surfaces=documented-only',
    'guards=documented-only',
    'grading=documented-only',
    '',
].join('\n'))

function fixture(registry = registryBytes, adoption = adoptionBytes) {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-registry-resolve-'))
    const registryPath = join(directory, 'registry.sh')
    const adoptionPath = join(directory, 'adoption.state')
    mkdirSync(directory, { recursive: true })
    writeFileSync(registryPath, registry)
    writeFileSync(adoptionPath, adoption)
    scratch.push(directory)
    return { directory, registryPath, adoptionPath }
}

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('registry resolver command', () => {
    it.each([
        ['registry', Buffer.alloc(1_048_577, 0x20), adoptionBytes, 'REGISTRY_TOO_LARGE'],
        ['adoption', registryBytes, Buffer.alloc(1_048_577, 0x20), 'ADOPTION_TOO_LARGE'],
    ])('refuses an oversized %s file before parsing', async (_kind, registry, adoption, code) => {
        const paths = fixture(registry, adoption)
        const outcome = await registryResolveCommand({
            registry: paths.registryPath,
            siblingsRoot: join(paths.directory, 'siblings'),
            adoption: paths.adoptionPath,
            cockpitSourceRevision: revision,
        })

        expect(outcome).toMatchObject({
            kind: 'refusal', artifact: null, result: null,
            diagnostics: [expect.objectContaining({ code })],
        })
    })

    it('refuses a sibling root containing the shell record delimiter', async () => {
        const { directory, registryPath, adoptionPath } = fixture()
        const outcome = await registryResolveCommand({
            registry: registryPath,
            siblingsRoot: join(directory, 'siblings|extra-field'),
            adoption: adoptionPath,
            cockpitSourceRevision: revision,
        })

        expect(outcome.kind).toBe('refusal')
        expect(outcome.artifact).toBeNull()
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'REGISTRY_ARTIFACT_UNSAFE' }))
    })

    it('reads exact bytes and resolves a complete tier registry in source order', async () => {
        const { directory, registryPath, adoptionPath } = fixture()
        const siblingsRoot = join(directory, "siblings' [literal]*")
        const input = { registry: registryPath, siblingsRoot, adoption: adoptionPath, cockpitSourceRevision: revision }

        const first = await registryResolveCommand(input)
        const second = await registryResolveCommand(input)

        expect(first.kind).toBe('complete')
        expect(first.status).toBe(0)
        expect(first.diagnostics).toEqual([])
        expect(first.artifact).toBe(second.artifact)
        expect(first.result).toEqual({
            registry: {
                format: '1',
                cockpitSourceRevision: revision,
                registrySha256: createHash('sha256').update(registryBytes).digest('hex'),
                dialect: 'tier',
                siblingCount: 3,
                adoption: [
                    { layer: 'registry', state: 'migrated' },
                    { layer: 'environment', state: 'documented-only' },
                    { layer: 'surfaces', state: 'documented-only' },
                    { layer: 'guards', state: 'documented-only' },
                    { layer: 'grading', state: 'documented-only' },
                ],
            },
        })
        expect(first.artifact).toContain("COCKPIT_REGISTRY_DIALECT='tier'")
        expect(first.artifact).toContain("api|api-service|ssh://example.invalid/api.git|main|required|API_DIR|Primary API")
        const decodedQuotes = first.artifact!.replaceAll(`'"'"'`, "'")
        expect(decodedQuotes).toContain(`${join(siblingsRoot, 'api-service')}|ssh://example.invalid/api.git|main`)
        expect(decodedQuotes).toContain(`API_DIR|${join(siblingsRoot, 'api-service')}`)
    })

    it.each([
        { label: 'missing registry', removeRegistry: true, code: 'REGISTRY_NOT_FOUND' },
        { label: 'empty registry', registry: Buffer.from(''), code: 'REGISTRY_EMPTY' },
        {
            label: 'ambiguous registry',
            registry: Buffer.from('X_SIBLINGS=(\n  "one|one|ssh://example.invalid/one.git|app|ONE_DIR|One"\n  "two|two|ssh://example.invalid/two.git|main|auto|TWO_DIR|Two"\n)\n'),
            code: 'REGISTRY_AMBIGUOUS',
        },
        {
            label: 'skipped registry row',
            registry: Buffer.from('X_SIBLINGS=(\n  "safe|safe|ssh://example.invalid/safe.git|main|required|SAFE_DIR|Safe"\n  "private-secret-value|too|few"\n)\n'),
            code: 'REGISTRY_ROW_SKIPPED',
        },
        { label: 'missing adoption', removeAdoption: true, code: 'ADOPTION_NOT_FOUND' },
        { label: 'empty adoption', adoption: Buffer.from(''), code: 'ADOPTION_EMPTY' },
    ])('refuses $label with a null artifact and no source-row disclosure', async ({
        registry = registryBytes,
        adoption = adoptionBytes,
        removeRegistry = false,
        removeAdoption = false,
        code,
    }) => {
        const paths = fixture(registry, adoption)
        if (removeRegistry) rmSync(paths.registryPath)
        if (removeAdoption) rmSync(paths.adoptionPath)

        const outcome = await registryResolveCommand({
            registry: paths.registryPath,
            siblingsRoot: join(paths.directory, 'siblings'),
            adoption: paths.adoptionPath,
            cockpitSourceRevision: revision,
        })

        expect(outcome.status).not.toBe(0)
        expect(outcome.artifact).toBeNull()
        expect(outcome.result).toBeNull()
        expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code)
        expect(JSON.stringify(outcome.diagnostics)).not.toContain('private-secret-value')
    })

    it('maps parser detail to a stable diagnostic without forwarding the rejected value', async () => {
        const rejectedValue = 'consumer-specific-tier'
        const paths = fixture(Buffer.from([
            'SYNTHETIC_SIBLINGS=(',
            `  "api|api-service|ssh://example.invalid/api.git|main|${rejectedValue}|API_DIR|Primary API"`,
            ')',
            '',
        ].join('\n')))

        const outcome = await registryResolveCommand({
            registry: paths.registryPath,
            siblingsRoot: join(paths.directory, 'siblings'),
            adoption: paths.adoptionPath,
            cockpitSourceRevision: revision,
        })

        expect(outcome.diagnostics).toEqual([
            expect.objectContaining({ code: 'REGISTRY_ROW_SKIPPED', target: 'registry line 2' }),
        ])
        expect(JSON.stringify(outcome.diagnostics)).not.toContain(rejectedValue)
        expect(JSON.stringify(outcome.diagnostics)).not.toContain('unknown tier')
    })

    it.each(['PATH', 'IFS', 'BASH_ENV', 'ORDINARY_VALUE']) (
        'refuses unsafe export namespace %s',
        async (variable) => {
            const paths = fixture(Buffer.from([
                'SYNTHETIC_SIBLINGS=(',
                `  "api|api-service|ssh://example.invalid/api.git|main|required|${variable}|Primary API"`,
                ')',
                '',
            ].join('\n')))
            const outcome = await registryResolveCommand({
                registry: paths.registryPath,
                siblingsRoot: join(paths.directory, 'siblings'),
                adoption: paths.adoptionPath,
                cockpitSourceRevision: revision,
            })

            expect(outcome).toEqual(expect.objectContaining({ artifact: null, result: null, status: 2 }))
            expect(outcome.diagnostics).toEqual([
                expect.objectContaining({ code: 'REGISTRY_VARIABLE_INVALID' }),
            ])
        },
    )

    it.each(['../outside', '/absolute/outside'])('refuses sibling dir escape %s', async (dir) => {
        const paths = fixture(Buffer.from([
            'SYNTHETIC_SIBLINGS=(',
            `  "api|${dir}|ssh://example.invalid/api.git|main|required|API_DIR|Primary API"`,
            ')',
            '',
        ].join('\n')))
        const outcome = await registryResolveCommand({
            registry: paths.registryPath,
            siblingsRoot: join(paths.directory, 'siblings'),
            adoption: paths.adoptionPath,
            cockpitSourceRevision: revision,
        })

        expect(outcome).toEqual(expect.objectContaining({ artifact: null, result: null, status: 2 }))
        expect(outcome.diagnostics).toEqual([
            expect.objectContaining({ code: 'REGISTRY_DIR_OUTSIDE_SIBLINGS_ROOT', target: 'registry field dir' }),
        ])
        expect(JSON.stringify(outcome.diagnostics)).not.toContain(dir)
    })

    it('refuses distinct rows that resolve to the same sibling directory', async () => {
        const rawAlias = 'nested/../api-service'
        const paths = fixture(Buffer.from([
            'SYNTHETIC_SIBLINGS=(',
            '  "api|api-service|ssh://example.invalid/api.git|main|required|API_DIR|Primary API"',
            `  "api-shadow|${rawAlias}|ssh://example.invalid/shadow.git|main|required|SHADOW_DIR|Distinct control"`,
            '  "web|web-app|ssh://example.invalid/web.git|main|auto|WEB_DIR|Non-duplicate control"',
            ')',
            '',
        ].join('\n')))

        const outcome = await registryResolveCommand({
            registry: paths.registryPath,
            siblingsRoot: join(paths.directory, 'siblings'),
            adoption: paths.adoptionPath,
            cockpitSourceRevision: revision,
        })

        expect(outcome).toEqual(expect.objectContaining({ artifact: null, result: null, status: 2 }))
        expect(outcome.diagnostics).toEqual([{
            severity: 'error',
            code: 'REGISTRY_DIR_DUPLICATE',
            message: 'multiple sibling rows resolve to the same directory',
            target: 'registry field dir',
            fix: undefined,
        }])
        expect(JSON.stringify(outcome.diagnostics)).not.toContain(rawAlias)
        expect(JSON.stringify(outcome.diagnostics)).not.toContain(paths.directory)
    })

    it.each([
        ['registry', Buffer.from([0xff]), registryBytes, 'REGISTRY_ENCODING_INVALID'],
        ['adoption', registryBytes, Buffer.from([0xff]), 'ADOPTION_ENCODING_INVALID'],
    ])('fatally refuses invalid UTF-8 in %s bytes', async (_label, registry, adoption, code) => {
        const paths = fixture(registry, adoption)
        const outcome = await registryResolveCommand({
            registry: paths.registryPath,
            siblingsRoot: join(paths.directory, 'siblings'),
            adoption: paths.adoptionPath,
            cockpitSourceRevision: revision,
        })

        expect(outcome).toEqual(expect.objectContaining({ artifact: null, result: null, status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code })])
    })

    it.each([
        ['duplicate layer', 'registry=migrated\nregistry=migrated\nsurfaces=documented-only\nguards=documented-only\ngrading=documented-only\n', 'ADOPTION_ORDER_INVALID'],
        ['unknown state', 'registry=migrated\nenvironment=pending\nsurfaces=documented-only\nguards=documented-only\ngrading=documented-only\n', 'ADOPTION_STATE_INVALID'],
        ['out-of-order migration', 'registry=migrated\nenvironment=documented-only\nsurfaces=migrated\nguards=documented-only\ngrading=documented-only\n', 'ADOPTION_ORDER_INVALID'],
        ['gap before migration', 'registry=documented-only\nenvironment=migrated\nsurfaces=documented-only\nguards=documented-only\ngrading=documented-only\n', 'ADOPTION_ORDER_INVALID'],
        ['partial record', 'registry=migrated\nenvironment=documented-only\n', 'ADOPTION_ORDER_INVALID'],
    ])('refuses %s before emitting bytes and states the record format', async (_label, adoption, code) => {
        const paths = fixture(registryBytes, Buffer.from(adoption))
        const outcome = await registryResolveCommand({
            registry: paths.registryPath,
            siblingsRoot: join(paths.directory, 'siblings'),
            adoption: paths.adoptionPath,
            cockpitSourceRevision: revision,
        })

        expect(outcome).toEqual(expect.objectContaining({ artifact: null, result: null, status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({
            code, fix: expect.stringContaining('registry=, environment=, surfaces=, guards=, grading='),
        })])
    })

    it('resolves an unreleased source build as development and says where the value came from', async () => {
        const paths = fixture()
        const outcome = await registryResolveCommand({
            registry: paths.registryPath,
            siblingsRoot: join(paths.directory, 'siblings'),
            adoption: paths.adoptionPath,
            cockpitSourceRevision: 'development',
        })

        expect(outcome).toMatchObject({ kind: 'complete', status: 0, result: { registry: { cockpitSourceRevision: 'development' } } })
        expect(outcome.artifact).toContain("COCKPIT_SOURCE_REVISION='development'\n")
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', code: 'COCKPIT_REVISION_UNSTAMPED' })])
    })

    it.each(['0123456789abcdef0123456789abcdef0123456g', 'abc'])(
        'refuses the malformed installed source revision %s after validating its input',
        async (cockpitSourceRevision) => {
            const paths = fixture()
            const outcome = await registryResolveCommand({
                registry: paths.registryPath,
                siblingsRoot: join(paths.directory, 'siblings'),
                adoption: paths.adoptionPath,
                cockpitSourceRevision,
            })

            expect(outcome).toEqual(expect.objectContaining({ artifact: null, result: null, status: 2 }))
            expect(outcome.diagnostics).toEqual([expect.objectContaining({
                code: 'COCKPIT_REVISION_INVALID', fix: expect.stringContaining('reinstall @b00dea/cockpit'),
            })])

            const malformed = fixture(Buffer.from('SYNTHETIC_SIBLINGS=(\n  "api|api-service"\n)\n'))
            const first = await registryResolveCommand({
                registry: malformed.registryPath,
                siblingsRoot: join(malformed.directory, 'siblings'),
                adoption: malformed.adoptionPath,
                cockpitSourceRevision,
            })
            expect(first.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('COCKPIT_REVISION_INVALID')
        },
    )

    it('contains one parser call site and no command peer or secret-file contact', () => {
        const source = requireSource('./command.ts')
        expect(source.match(/\bparseRegistry\s*\(/g)).toHaveLength(1)
        expect(source).toMatch(/import\s*\{[^}]*\bparseRegistry\b[^}]*\}\s*from\s*'\.\/registry\.js'/)
        expect(source).not.toMatch(/init\/draft|\.secrets|local\.env/)
    })
})

function requireSource(relativePath: string): string {
    const url = new URL(relativePath, import.meta.url)
    return readFileSync(url, 'utf8')
}
