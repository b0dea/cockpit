import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { inspectProjectReadiness } from './readiness-composition.js'

const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('project readiness', () => {
    // Git refuses a repository another user owns (safe.directory) with exit 128, as it exits outside
    // any repository; that read as "not a working tree" and as a repository that commits no secrets.
    it('names a repository Git refuses for its ownership, never a missing working tree or a clean one', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-readiness-')))
        scratch.push(base)
        const root = join(base, 'cockpit')
        const sibling = join(base, 'api')
        const bin = join(base, 'bin')
        await Promise.all([root, sibling, bin].map(path => mkdir(path)))
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
})
