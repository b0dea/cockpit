import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'

import { checkGeneratedEnvironment, syncGeneratedEnvironment } from '../generated-environment/command.js'
import { publicationCockpitId } from '../environment/identity.js'
import { deriveRegistry } from '../registry-derivation.js'
import { observeSiblingGuides, planSiblingProjection } from './projection.js'
import { SURFACE_TARGETS } from './harness-registry.js'

const baselineFixture = resolve('fixtures/registries/generated-environment.toml')
const rowFixture = resolve('packages/cockpit/src/surfaces/fixtures/one-row.toml')
const roots: string[] = []
const credentialCanary = 'synthetic-credential-canary'

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function consumer(name: string, includeRow: boolean) {
    const root = await realpath(await mkdtemp(join(tmpdir(), `cockpit-one-row-${name}-`)))
    roots.push(root)
    const baseline = (await readFile(baselineFixture, 'utf8')).replace(
        'name = "generated-environment"',
        'name = "generated-environment"\nsiblings_root = "."',
    )
    const row = await readFile(rowFixture, 'utf8')
    const configPath = join(root, 'cockpit.toml')
    // Every shipped tool is listed so the row's grants are checked in each tool's spelling.
    await writeFile(configPath, `${includeRow ? `${baseline}\n${row}` : baseline}\n[surfaces]\ntools = ${JSON.stringify(SURFACE_TARGETS)}\n`)
    await Promise.all([
        mkdir(join(root, 'app'), { recursive: true }),
        mkdir(join(root, 'fixtures'), { recursive: true }),
        mkdir(join(root, 'worker'), { recursive: true }),
    ])
    await Promise.all([
        writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n'),
        writeFile(join(root, 'app/package-lock.json'), '{}\n'),
        writeFile(join(root, 'worker/package-lock.json'), '{}\n'),
        writeFile(join(root, 'worker/AGENTS.md'), 'Synthetic worker guide.\n'),
        writeFile(join(root, 'worker/CONTROL.md'), 'Synthetic worker guide.\n'),
        writeFile(join(root, 'worker/.env.example'), 'SYNTHETIC_TOKEN=\n'),
        writeFile(join(root, 'worker/.env.local'), `SYNTHETIC_TOKEN=${credentialCanary}\n`),
        writeFile(join(root, 'worker/.mcp.json'), `${JSON.stringify({
            mcpServers: {
                'row-server': {
                    command: '/usr/bin/printenv',
                    env: { SYNTHETIC_TOKEN: '${SYNTHETIC_TOKEN}' },
                },
            },
        })}\n`),
    ])
    return { root, configPath, row }
}

async function capturedEntry(root: string, path: string): Promise<string> {
    const absolute = join(root, path)
    const state = await lstat(absolute)
    return state.isSymbolicLink() ? `symlink:${await readlink(absolute)}` : `file:${await readFile(absolute, 'utf8')}`
}

async function capturedOutputs(root: string, paths: readonly string[]) {
    return Object.fromEntries(await Promise.all(paths.map(async path => [path, await capturedEntry(root, path)])))
}

async function expectDrift(configPath: string, target: string) {
    const checked = await checkGeneratedEnvironment({ configPath })
    expect(checked).toMatchObject({
        kind: 'refusal',
        status: 2,
        diagnostics: [expect.objectContaining({ target })],
    })
    if (checked.kind !== 'refusal') return
    expect(checked.diagnostics[0]?.code).toMatch(/^(?:GENERATED_ARTIFACT_DRIFT|SURFACE_STATE_CONFLICT)$/)
}

describe('one-row generated surface integration', () => {
    it('derives every accepted output and catches every serial drift control from one registry row', async () => {
        const [baseline, added] = await Promise.all([consumer('baseline', false), consumer('added', true)])
        for (const fixture of [baseline, added]) expect(spawnSync('git', ['init', '--quiet', fixture.root]).status).toBe(0)
        expect(added.row.match(/^\[\[sibling\]\]$/gm)).toHaveLength(1)
        expect(added.row).not.toMatch(/^\[(?:cockpit|ports|environment|mcp|guards|surfaces|workorders)\]/m)

        const declaration = parseToml(await readFile(added.configPath, 'utf8'))
        const registry = deriveRegistry(declaration)
        expect(registry.kind).toBe('complete')
        if (registry.kind !== 'complete') throw new Error(registry.message)
        expect(registry.result.mcpSources).toHaveLength(1)
        expect(registry.result.secretPaths).toContainEqual({
            slug: 'worker', siblingDir: 'worker', path: '.env.local', kind: 'instance',
        })

        const targets = ['claudecode', 'codexcli', 'opencode'] as const
        const guideObservation = await observeSiblingGuides({
            allowedRoots: [join(added.root, 'worker')],
            requests: [{
                slug: 'worker', root: join(added.root, 'worker'),
                sourcePath: join(added.root, 'worker/AGENTS.md'),
            }],
        })
        expect(guideObservation.kind).toBe('complete')
        if (guideObservation.kind !== 'complete') throw new Error(guideObservation.diagnostic.message)
        const projectionInput = {
            canonicalMainCheckout: added.root,
            siblingsRoot: '.',
            activeProfiles: ['application', 'worker'],
            guideCapLines: 8,
            siblings: registry.result.config.sibling.map(sibling => ({
                slug: sibling.slug, mount: sibling.mount, directoryAuthority: sibling.dir, guides: sibling.guides,
            })),
            mountedPaths: registry.result.config.sibling.map(sibling => ({
                slug: sibling.slug, path: join(added.root, sibling.dir),
            })),
            directoryGrants: registry.result.config.sibling.flatMap(sibling => SURFACE_TARGETS.map(target => ({
                slug: sibling.slug, target, path: join(added.root, sibling.dir),
            }))),
            guideObservations: guideObservation.observations,
            standingSources: targets.map(target => ({
                target, path: `${target}.scoped`, content: 'scoped first\nscoped second\n', scope: 'scoped' as const,
            })),
            loadCharacterizations: {
                claudecode: { measuredOn: '2026-09-26', provenance: 'paired synthetic probe', metric: 'lines' as const, scopeSemantics: 'conditional' as const },
                codexcli: { measuredOn: '2026-09-26', provenance: 'paired synthetic probe', metric: 'lines' as const, scopeSemantics: 'full' as const },
                opencode: { measuredOn: '2026-09-26', provenance: 'paired synthetic probe', metric: 'lines' as const, scopeSemantics: 'full' as const },
            },
        }
        const projection = planSiblingProjection(projectionInput)
        expect(projection).toMatchObject({
            kind: 'complete',
            guides: [expect.objectContaining({ sibling: 'worker', guide: 'AGENTS.md' })],
            costs: [
                { target: 'claudecode', status: 'within_cap', metric: 'lines', value: 6, conditionalValue: 2, cap: 8,
                    measuredOn: '2026-09-26', provenance: 'paired synthetic probe', scopeSemantics: 'conditional' },
                { target: 'codexcli', status: 'within_cap', metric: 'lines', value: 8, conditionalValue: 0, cap: 8,
                    measuredOn: '2026-09-26', provenance: 'paired synthetic probe', scopeSemantics: 'full' },
                { target: 'opencode', status: 'within_cap', metric: 'lines', value: 8, conditionalValue: 0, cap: 8,
                    measuredOn: '2026-09-26', provenance: 'paired synthetic probe', scopeSemantics: 'full' },
            ],
        })
        const wrongGrant = structuredClone(projectionInput)
        wrongGrant.directoryGrants.find(grant => grant.slug === 'worker' && grant.target === 'codexcli')!.path = join(added.root, 'nested/worker')
        expect(planSiblingProjection(wrongGrant)).toMatchObject({
            kind: 'refusal', diagnostic: { code: 'PROJECTION_GRANT_MISMATCH', target: 'worker:codexcli' },
        })

        const [baselineSync, addedSync] = await Promise.all([
            syncGeneratedEnvironment({ configPath: baseline.configPath }),
            syncGeneratedEnvironment({ configPath: added.configPath }),
        ])
        expect(baselineSync, JSON.stringify(baselineSync.diagnostics)).toMatchObject({ kind: 'complete' })
        expect(addedSync, JSON.stringify(addedSync.diagnostics)).toMatchObject({ kind: 'complete' })
        if (baselineSync.kind !== 'complete' || addedSync.kind !== 'complete') return

        const sharedOwner = publicationCockpitId({ name: 'generated-environment' })
        expect(baselineSync.result.paths).toContain('CLAUDE.md')
        expect(addedSync.result.paths).toContain('CLAUDE.md')
        const before = await capturedOutputs(baseline.root, baselineSync.result.paths)
        const after = await capturedOutputs(added.root, addedSync.result.paths)
        expect(before['CLAUDE.md']).toBe(after['CLAUDE.md'])
        expect(after['CLAUDE.md']).toBe(`file:<!-- cockpit:instructions:start -->\n<!-- cockpit:owner:${sharedOwner}:start -->\n@AGENTS.md\n<!-- cockpit:owner:${sharedOwner}:end -->\n<!-- cockpit:instructions:end -->\n`)
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
            .filter(path => before[path] !== after[path])
            .sort()
        // The common-guide import and guard registrations name neither the checkout nor the row,
        // so a new row leaves them byte-identical.
        expect(changed).toEqual([
            '.claude/settings.json',
            '.cockpit/mcp/65dfe895cdc7ae8504fb9a4430d8a72d14b21aa8792a20d78ac1eecfa6113cc6.sh',
            '.codex/config.toml',
            '.cursor/cli.json',
            '.cursor/mcp.json',
            '.grok/config.toml',
            '.mcp.json',
            'AGENTS.md',
            'opencode.jsonc',
        ])

        expect(after['AGENTS.md']).toContain('## Instructions for sibling `worker` (its AGENTS.md)')
        expect(after['AGENTS.md']).toContain('Synthetic worker guide.')
        expect(before['AGENTS.md']).not.toContain('Synthetic worker guide.')

        const claudeMcp = JSON.parse(await readFile(join(added.root, '.mcp.json'), 'utf8')) as {
            mcpServers: Record<string, unknown>
        }
        const claudeSettings = JSON.parse(await readFile(join(added.root, '.claude/settings.json'), 'utf8')) as {
            enabledMcpjsonServers?: string[]
            disabledMcpjsonServers?: string[]
        }
        const codex = parseToml(await readFile(join(added.root, '.codex/config.toml'), 'utf8')) as {
            mcp_servers: Record<string, { enabled?: boolean }>
        }
        const openCodeBytes = await readFile(join(added.root, 'opencode.jsonc'), 'utf8')
        const ownerPattern = /\/\* cockpit:owner:(cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}):(start|end) \*\//g
        const ownerId = publicationCockpitId({ name: 'generated-environment' })
        expect([...openCodeBytes.matchAll(ownerPattern)].map(match => [match[1], match[2]])).toEqual([
            [ownerId, 'start'], [ownerId, 'end'],
        ])
        const openCodeJson = openCodeBytes.replace(ownerPattern, marker => ' '.repeat(marker.length))
        expect(openCodeJson).not.toContain('cockpit:owner:')
        const openCode = JSON.parse(openCodeJson) as {
            mcp: Record<string, { enabled: boolean }>
        }
        // A sibling's MCP source is an ordinary file an agent can write, and a harness starts an
        // enabled server outside every guard boundary, so by default a declared server stays off
        // until a person records its digest.
        expect(Object.keys(claudeMcp.mcpServers)).toEqual(['row-server'])
        expect(claudeSettings.enabledMcpjsonServers ?? []).toEqual([])
        expect(claudeSettings.disabledMcpjsonServers).toEqual(['row-server'])
        expect(codex.mcp_servers['row-server']?.enabled).toBe(false)
        expect(openCode.mcp['row-server']?.enabled).toBe(false)
        // The guard refuses an agent's approval, so the fix names who approves.
        expect(addedSync.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'MCP_NOT_APPROVED', target: 'row-server',
            fix: expect.stringMatching(/^a person reviews its declaration, sets its name to the sha256/) }))

        const evidence = [
            JSON.stringify(addedSync),
            ...(await Promise.all(addedSync.result.paths.map(path => capturedEntry(added.root, path)))),
            await readFile(join(added.root, '.cockpit/generated-environment-ownership.json'), 'utf8'),
        ].join('\n')
        expect(evidence).not.toContain(credentialCanary)
        const generatedGuard = await readFile(join(added.root, '.cockpit/guards/bash-guard.sh'), 'utf8')
        expect(generatedGuard).not.toContain(credentialCanary)
        // Every `.env.*` file is denied by default; the declared instance is denied under its own reason.
        const dotenv = 'Refusing to read or write an environment file: `.env` and `.env.*` hold secrets unless named .env.example, .env.sample, .env.template or .env.schema, or declared as a template. '
            + 'Fix: an agent runs the trusted process through a declared project command or script that wraps Varlock; a person in a terminal runs that same command, or `VARLOCK_TELEMETRY_DISABLED=true varlock run -- <cmd>`, without `--redact-stdout`, which Varlock refuses on a terminal. Consult schema names only where native permissions allow them.'
        for (const [fixture, path, reason] of [
            [baseline, '.env.local', dotenv],
            [added, '.env.local', 'Refusing mutation or staging of a declared environment instance.'],
            [added, '.env.example', undefined],
        ] as const) {
            const guarded = spawnSync('/bin/bash', [join(fixture.root, '.cockpit/guards/bash-guard.sh'), '--harness', 'claudecode'], {
                cwd: fixture.root,
                input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: fixture.root,
                    tool_input: { file_path: join(fixture.root, 'worker', path), content: 'synthetic replacement' } }),
                encoding: 'utf8', timeout: 30_000, maxBuffer: 65_536,
            })
            expect(guarded.error).toBeUndefined()
            expect(guarded.status, guarded.stderr).toBe(0)
            if (reason) expect(JSON.parse(guarded.stdout)).toEqual({ hookSpecificOutput: {
                hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
            } })
            else expect(guarded.stdout).toBe('')
            expect(guarded.stdout + guarded.stderr).not.toContain(credentialCanary)
        }

        // A sibling's own guide edit leaves the committed copy stale; check names that guide until sync.
        const guide = join(added.root, 'worker/AGENTS.md')
        await writeFile(guide, 'Synthetic worker guide, edited.\n')
        expect(await checkGeneratedEnvironment({ configPath: added.configPath })).toMatchObject({
            kind: 'refusal', status: 2, diagnostics: [expect.objectContaining({
                code: 'GENERATED_ARTIFACT_DRIFT', target: 'AGENTS.md', message: expect.stringContaining('out-of-date copy of worker/AGENTS.md'),
            })],
        })
        await writeFile(guide, 'Synthetic worker guide.\n')
        expect(await checkGeneratedEnvironment({ configPath: added.configPath })).toMatchObject({ kind: 'complete' })

        const fileControls = [
            '.cockpit/guards/bash-guard.sh',
            '.mcp.json',
        ] as const
        for (const target of fileControls) {
            const original = await readFile(join(added.root, target), 'utf8')
            if (target === '.mcp.json') await rm(join(added.root, target))
            else await writeFile(join(added.root, target), `${original}\n# stale control\n`)
            await expectDrift(added.configPath, target)
            await writeFile(join(added.root, target), original)
            expect(await checkGeneratedEnvironment({ configPath: added.configPath })).toMatchObject({ kind: 'complete' })
        }

        const codexPath = join(added.root, '.codex/config.toml')
        const codexBytes = await readFile(codexPath, 'utf8')
        const codexDocument = parseToml(codexBytes)
        expect({ sandbox_mode: codexDocument.sandbox_mode, sandbox_workspace_write: codexDocument.sandbox_workspace_write }).toEqual({
            sandbox_mode: 'workspace-write',
            // Codex resolves a relative root from `.codex/`.
            sandbox_workspace_write: { writable_roots: ['../app', '../worker'] },
        })
        const changedCodexBytes = codexBytes.replace('"../worker"', '"../nested/worker"')
        expect(changedCodexBytes).not.toBe(codexBytes)
        expect(parseToml(changedCodexBytes)).toEqual({
            ...codexDocument,
            sandbox_workspace_write: { writable_roots: ['../app', '../nested/worker'] },
        })
        await writeFile(codexPath, changedCodexBytes)
        await expectDrift(added.configPath, '.codex/config.toml')
        await writeFile(codexPath, codexBytes)
        expect(await readFile(codexPath, 'utf8')).toBe(codexBytes)
        expect(await checkGeneratedEnvironment({ configPath: added.configPath })).toMatchObject({ kind: 'complete' })

        const nested = join(added.root, 'nested')
        await mkdir(nested)
        await rename(join(added.root, 'worker'), join(nested, 'worker'))
        await symlink('nested/worker', join(added.root, 'worker'))
        const wrongRoot = await checkGeneratedEnvironment({ configPath: added.configPath })
        expect(wrongRoot).toMatchObject({ kind: 'refusal', status: 2 })
        expect(JSON.stringify(wrongRoot)).not.toContain(credentialCanary)
        await rm(join(added.root, 'worker'))
        await rename(join(nested, 'worker'), join(added.root, 'worker'))
        expect(await checkGeneratedEnvironment({ configPath: added.configPath })).toMatchObject({ kind: 'complete' })

        const wrapper = `.cockpit/mcp/${createHash('sha256').update('row-server').digest('hex')}.sh`
        expect(addedSync.result.paths).toContain(wrapper)
    }, 180_000)
})
