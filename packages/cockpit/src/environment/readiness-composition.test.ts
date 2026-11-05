import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadCockpitConfig } from '../config/load.js'
import { executeProbe } from '../environment-exec/execute.js'
import { readinessReport } from '../readiness.js'
import { STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'
import { inspectProjectReadiness } from './readiness-composition.js'

const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('project readiness', () => {
    it('keeps schema discovery within the root entry budget and reports an incomplete scan', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-readiness-')))
        scratch.push(base)
        const root = join(base, 'cockpit')
        const bin = join(base, 'empty-path')
        await Promise.all([mkdir(root), mkdir(bin)])
        await writeFile(join(root, '.env'), 'SYNTHETIC_KEY=\n')
        for (let start = 1; start < STRUCTURED_INPUT_ENTRY_LIMIT; start += 64) {
            await Promise.all(Array.from({ length: Math.min(64, STRUCTURED_INPUT_ENTRY_LIMIT - start) },
                (_, index) => writeFile(join(root, `entry-${start + index}`), '')))
        }
        const input = { root, checkRoot: false, env: { PATH: bin }, timeoutMs: 5_000 }
        const within = await inspectProjectReadiness(input, executeProbe)
        expect(within.filter(({ target }) => target === root)).toEqual([expect.objectContaining({
            severity: 'warning', code: 'ENV_SCHEMA_UNDECLARED',
        })])

        await writeFile(join(root, 'entry-over-limit'), '')
        const exceeded = await inspectProjectReadiness(input, executeProbe)
        expect(exceeded.filter(({ target }) => target === root)).toEqual([expect.objectContaining({
            severity: 'warning', code: 'EVIDENCE_UNAVAILABLE',
            message: expect.stringContaining('root entry limit'),
        })])
    })

    it('reports an unavailable metadata scan as a warning rather than refusing readiness', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-readiness-')))
        scratch.push(base)
        const root = join(base, 'cockpit')
        const bin = join(base, 'empty-path')
        await Promise.all([mkdir(root), mkdir(bin)])
        await chmod(root, 0o000)
        try {
            const findings = await inspectProjectReadiness({ root, checkRoot: false,
                env: { PATH: bin }, timeoutMs: 5_000 }, executeProbe)
            expect(findings).toContainEqual(expect.objectContaining({
                severity: 'warning', code: 'EVIDENCE_UNAVAILABLE', target: root,
                message: expect.stringContaining('schema adoption'),
            }))
        } finally {
            await chmod(root, 0o700)
        }
    })

    it.each(['init', 'doctor'] as const)('recommends schema adoption from root file metadata in %s without making it a prerequisite', async (command) => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-readiness-')))
        scratch.push(base)
        const repositories = ['cockpit', 'template', 'declared', 'empty', 'nested', 'dotenv'].map(slug => ({ slug, root: join(base, slug) }))
        const root = repositories[0]!.root
        const template = repositories[1]!.root
        const declared = repositories[2]!.root
        const dotenv = repositories[5]!.root
        const bin = join(base, 'empty-path')
        await Promise.all([...repositories.map(repository => repository.root), bin].map(path => mkdir(path)))
        await Promise.all([
            writeFile(join(root, '.env'), 'SYNTHETIC_VALUE=not-for-diagnostics\n', { mode: 0o000 }),
            writeFile(join(template, 'env.template'), 'SYNTHETIC_KEY=\n'),
            writeFile(join(dotenv, '.env.example'), 'SYNTHETIC_KEY=\n'),
            writeFile(join(declared, '.env.sample'), 'SYNTHETIC_KEY=\n'),
            symlink('absent-schema-target', join(declared, '.env.schema')),
            mkdir(join(repositories[3]!.root, '.env')),
            mkdir(join(repositories[4]!.root, 'child')),
        ])
        await writeFile(join(repositories[4]!.root, 'child', '.env'), 'SYNTHETIC_KEY=\n')
        const configPath = join(root, 'cockpit.toml')
        if (command === 'doctor') await writeFile(configPath, [
            '[cockpit]', 'name = "readiness"', 'siblings_root = ".."',
            ...repositories.flatMap(({ slug }) => ['[[sibling]]', `slug = "${slug}"`, `dir = "${slug}"`,
                'acquire = "none"', 'mount = "none"', `var = "${slug.toUpperCase()}_DIR"`, 'purpose = "Synthetic repository"']),
            '[ports.bases]',
        ].join('\n'))
        if (command === 'doctor') {
            const loaded = await loadCockpitConfig(configPath)
            expect(loaded, JSON.stringify(loaded.diagnostics)).toMatchObject({ kind: 'complete' })
        }
        const input = { root, ...(command === 'doctor' ? { configPath } : { repositories }),
            checkRoot: false, env: { PATH: bin }, timeoutMs: 5_000 }

        const findings = await inspectProjectReadiness(input, executeProbe)
        const missing = findings.filter(({ code }) => code === 'ENV_SCHEMA_UNDECLARED')
        expect(missing).toEqual([root, template, dotenv].map(target => expect.objectContaining({
            severity: 'warning', code: 'ENV_SCHEMA_UNDECLARED', target,
            fix: expect.stringContaining('ask a person to run VARLOCK_TELEMETRY_DISABLED=true varlock init'),
        })))
        expect(JSON.stringify(missing)).not.toContain('not-for-diagnostics')
        expect(readinessReport('surfaces-only', missing, []).gaps).toEqual([
            expect.objectContaining({ id: 'env-schema-declared', level: 'recommended' }),
        ])

        await Promise.all([root, template, dotenv].map(path => writeFile(join(path, '.env.schema'), 'SYNTHETIC_KEY=\n')))
        expect((await inspectProjectReadiness(input, executeProbe)).filter(({ code }) => code === 'ENV_SCHEMA_UNDECLARED')).toEqual([])
    })

    // Git refuses a repository another user owns (safe.directory) with exit 128, as it exits outside
    // any repository; that read as "not a working tree" and as a repository that commits no secrets.
    it('names a repository Git refuses for its ownership, never a missing working tree or a clean one', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-readiness-')))
        scratch.push(base)
        const root = join(base, 'cockpit')
        const sibling = join(base, 'api')
        const bin = join(base, 'bin')
        await Promise.all([root, sibling, bin].map(path => mkdir(path)))
        // Instructions every tool loads, so the only findings are Git's.
        await Promise.all([writeFile(join(sibling, 'AGENTS.md'), '# API\n'), writeFile(join(sibling, 'CLAUDE.md'), '@AGENTS.md\n')])
        // Git 2.54.0's own words for a repository whose owner is another user (2026-11-03).
        await writeFile(join(bin, 'git'), [
            '#!/bin/sh',
            `printf "fatal: detected dubious ownership in repository at '%s'\\nTo add an exception for this directory, call:\\n\\n\\tgit config --global --add safe.directory %s\\n" "$PWD" "$PWD" >&2`,
            'exit 128',
            '',
        ].join('\n'))
        await chmod(join(bin, 'git'), 0o700)

        const findings = await inspectProjectReadiness({ root, repositories: [{ slug: 'api', root: sibling }], checkRoot: true,
            env: { PATH: bin }, timeoutMs: 5_000 }, executeProbe)

        expect(findings).toEqual([root, sibling].map(owned => expect.objectContaining({
            severity: 'warning', code: 'EVIDENCE_UNAVAILABLE', target: owned === root ? root : 'sibling:api',
            message: expect.stringContaining(`Git refuses to read ${owned} because another user owns it`),
            fix: `ask the person who owns this machine whether to trust ${owned}; only if they agree, run git config --global --add safe.directory ${owned}, then rerun this command`,
        })))
    })

    // Agents started in a sibling load only the files their tool reads; the cockpit root's own guides
    // come from sync and are no finding.
    it('names the sibling whose instruction files leave a tool without its instructions, even without Git', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-readiness-')))
        scratch.push(base)
        const root = join(base, 'cockpit')
        const sibling = join(base, 'api')
        await Promise.all([root, sibling, join(base, 'empty-path')].map(path => mkdir(path)))
        await Promise.all([writeFile(join(root, 'AGENTS.md'), '# Cockpit\n'), writeFile(join(sibling, 'AGENTS.md'), '# API\n')])

        const findings = await inspectProjectReadiness({ root, repositories: [{ slug: 'cockpit', root }, { slug: 'api', root: sibling }],
            checkRoot: false, env: { PATH: join(base, 'empty-path') }, timeoutMs: 5_000 }, executeProbe)

        expect(findings.filter(({ code }) => code.startsWith('SIBLING_INSTRUCTIONS_'))).toEqual([expect.objectContaining({
            severity: 'warning', code: 'SIBLING_INSTRUCTIONS_AGENTS_ONLY', target: 'sibling:api',
        })])
    })
})
