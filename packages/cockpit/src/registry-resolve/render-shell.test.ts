import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderResolvedRegistryShell } from './render-shell.js'

const scratch: string[] = []

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

const model = {
    formatVersion: '1',
    cockpitSourceRevision: '0123456789abcdef0123456789abcdef01234567',
    registrySha256: 'a'.repeat(64),
    dialect: 'tier' as const,
    siblingsRoot: "/srv/cockpit-fixtures' [literal]*",
    rows: ["web|web-app|ssh://example.invalid/web.git|main|auto|WEB_DIR|O'Reilly [literal]*"],
    paths: ["/srv/cockpit-fixtures' [literal]*/web-app|ssh://example.invalid/web.git|main"],
    variables: [{ name: 'WEB_DIR', defaultPath: "/srv/cockpit-fixtures' [literal]*/web-app" }],
    adoption: [
        { layer: 'registry', state: 'migrated' },
        { layer: 'environment', state: 'documented-only' },
        { layer: 'surfaces', state: 'documented-only' },
        { layer: 'guards', state: 'documented-only' },
        { layer: 'grading', state: 'documented-only' },
    ],
}

describe('resolved registry shell rendering', () => {
    it.each([
        { ...model, siblingsRoot: '/synthetic|extra' },
        { ...model, variables: [{ name: 'WEB_DIR', defaultPath: '/synthetic|extra' }] },
        { ...model, paths: ['/synthetic|extra|remote|main'] },
        { ...model, adoption: [{ layer: 'registry|extra', state: 'migrated' }] },
        { ...model, adoption: [{ layer: 'registry', state: 'migrated|extra' }] },
        { ...model, rows: [`${model.rows[0]}|extra`] },
    ])('refuses ambiguous delimited records before rendering bytes %#', (unsafe) => {
        expect(() => renderResolvedRegistryShell(unsafe)).toThrow(/REGISTRY_ARTIFACT_UNSAFE/)
    })

    it('renders exact deterministic data-only bytes through one POSIX quote form', () => {
        const expected = [
            "COCKPIT_REGISTRY_FORMAT='1'",
            "COCKPIT_SOURCE_REVISION='0123456789abcdef0123456789abcdef01234567'",
            `COCKPIT_REGISTRY_SHA256='${'a'.repeat(64)}'`,
            "COCKPIT_REGISTRY_DIALECT='tier'",
            "COCKPIT_SIBLINGS_ROOT='/srv/cockpit-fixtures'\"'\"' [literal]*'",
            "COCKPIT_REGISTRY_ROWS=(",
            "  'web|web-app|ssh://example.invalid/web.git|main|auto|WEB_DIR|O'\"'\"'Reilly [literal]*'",
            ')',
            'COCKPIT_SIBLING_PATHS=(',
            "  '/srv/cockpit-fixtures'\"'\"' [literal]*/web-app|ssh://example.invalid/web.git|main'",
            ')',
            'COCKPIT_SIBLING_VARIABLES=(',
            "  'WEB_DIR|/srv/cockpit-fixtures'\"'\"' [literal]*/web-app'",
            ')',
            'COCKPIT_ADOPTION_STATES=(',
            "  'registry|migrated'",
            "  'environment|documented-only'",
            "  'surfaces|documented-only'",
            "  'guards|documented-only'",
            "  'grading|documented-only'",
            ')',
            "export WEB_DIR='/srv/cockpit-fixtures'\"'\"' [literal]*/web-app'",
            '',
        ].join('\n')

        expect(renderResolvedRegistryShell(model)).toBe(expected)
        expect(renderResolvedRegistryShell(model)).toBe(expected)
        expect(expected).not.toMatch(/\b(?:eval|if|then|case|function)\b|\$\(|`/)
    })

    it.each([
        ['NUL', '\0'],
        ['carriage return', '\r'],
        ['line feed', '\n'],
        ['command substitution', '$(touch synthetic-marker)'],
        ['parameter substitution', '${SYNTHETIC_VALUE}'],
        ['backtick substitution', '`touch synthetic-marker`'],
    ])('refuses %s before rendering any bytes', (_label, unsafe) => {
        expect(() => renderResolvedRegistryShell({ ...model, siblingsRoot: `/synthetic/${unsafe}` })).toThrow(
            /REGISTRY_ARTIFACT_UNSAFE/,
        )
    })

    it.each(['WEB-DIR', 'PATH', 'IFS', 'BASH_ENV', 'ORDINARY_VALUE'])(
        'refuses unsafe exported variable name %s',
        (name) => {
            expect(() =>
                renderResolvedRegistryShell({
                    ...model,
                    variables: [{ name, defaultPath: '/synthetic/web' }],
                }),
            ).toThrow(/REGISTRY_VARIABLE_INVALID/)
        },
    )

    it.each(['bash', 'zsh'])('is sourceable in %s while an executable broken control is observably broken', (shell) => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-render-shell-'))
        scratch.push(directory)
        const clean = join(directory, 'clean.sh')
        const broken = join(directory, 'broken-control.sh')
        const marker = join(directory, 'broken-control-ran')
        writeFileSync(clean, renderResolvedRegistryShell(model))
        writeFileSync(broken, `BROKEN_CONTROL=$(touch '${marker}')\n`)

        const cleanResult = spawnSync(shell, ['-c', `. '${clean}'; printf '%s' "$WEB_DIR"`], { encoding: 'utf8' })
        const brokenResult = spawnSync(shell, ['-c', `. '${broken}'`], { encoding: 'utf8' })

        // An absent shell exits null, not non-zero, so without this the failure reads
        // "expected null to be 0" and never names the binary the host is missing.
        expect(cleanResult.error ?? brokenResult.error, `${shell} is not installed on this host`).toBeUndefined()
        expect(cleanResult.status).toBe(0)
        expect(cleanResult.stdout).toBe(model.variables[0].defaultPath)
        expect(brokenResult.status).toBe(0)
        expect(spawnSync('test', ['-f', marker]).status).toBe(0)
    })
})
