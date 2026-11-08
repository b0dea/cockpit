import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runSelftestOperatorCommand } from '../environment/selftest-application.js'

const artifact = {
    canonicalPath: '/synthetic/probes.json', sha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64),
    generatedManifestSha256: 'c'.repeat(64),
    commandVectors: [
        { harness: 'Codex', capability: 'instruction-loading', skill: null, invocation: ['{executable}', 'debug', 'prompt-input'],
            versionCommand: ['{executable}', '--version'], helpCommand: ['{executable}', '--help'], executes: true },
        { harness: 'Codex', capability: 'guard-firing', skill: null, invocation: ['NEVER-RUN-THIS'],
            versionCommand: ['NEVER-VERSION'], helpCommand: ['NEVER-HELP'], executes: false },
    ],
} as const

const executable = { harness: 'Codex', canonicalPath: '/synthetic/bin/codex', sha256: 'd'.repeat(64) } as const

describe('selftest terminal review', () => {
    it.each(['yes', 'no', '', 'approve', 'eof'])('binds %j to only the displayed artifact and executable', async answer => {
        const stdin = Object.assign(new PassThrough(), { isTTY: true })
        const shown: string[] = []
        const approvals: (string | undefined)[] = []
        let prompts = 0
        await runSelftestOperatorCommand({ configPath: 'cockpit.toml', probeSpecificationsPath: 'probe.json', env: {} },
            { interactive: true, json: false, ci: undefined }, {
                stdin: stdin as unknown as NodeJS.ReadStream,
                stderr: new Writable({ write: (bytes, _encoding, done) => {
                    const chunk = String(bytes)
                    shown.push(chunk)
                    if (chunk.includes('[yes/no]')) {
                        prompts++
                        setImmediate(() => answer === 'eof' ? stdin.end() : stdin.write(`${answer}\n`))
                    } else if (chunk.includes('Type the exact SHA-256')) {
                        // Drive the old prompt too, so its failure is an assertion rather than a timeout.
                        setImmediate(() => stdin.write(`${answer}\n`))
                    }
                    done()
                } }),
            }, async request => {
                approvals.push(await request.requestProbeSpecificationsApproval!(artifact))
                if (answer !== 'eof') approvals.push(await request.requestExecutableApproval!(executable))
                return { status: 0, diagnostics: [], result: null }
            })
        expect(prompts).toBe(answer === 'eof' ? 1 : 2)
        expect(approvals).toEqual(answer === 'yes' ? [artifact.sha256, executable.sha256]
            : answer === 'eof' ? [undefined] : [undefined, undefined])
        expect(shown.join('')).toContain('/synthetic/probes.json')
        expect(shown.join('')).toContain(artifact.sha256)
        expect(shown.join('')).toContain('debug')
        expect(shown.join('')).not.toContain('NEVER-RUN-THIS')
        expect(shown.join('')).toContain('1 unsupported')
        stdin.destroy()
    })
})
