import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
    IMPLEMENTED_MECHANISMS,
    validateEvidenceManifest,
    validateEvidenceManifests,
    validateSelftestEvidenceBundle,
} from '../libexec/validate-harness-evidence.mjs'
import type {
    BuiltinExecutionAuthority,
    BuiltinHarnessRef,
    CustomHarnessRef,
    SelftestCapability,
    SelftestEvidenceRecord,
    SelftestProbeEvent,
} from '../libexec/validate-harness-evidence.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VALIDATOR = join(ROOT, 'packages/cockpit/libexec/validate-harness-evidence.mjs')
const CANDIDATE = 'fixtures/harness-probes/candidate-control.json'
const BROKEN = 'fixtures/harness-probes/broken-control.json'
const TRANSCRIPT = 'fixtures/harness-probes/synthetic-transcript.txt'
const DIRECT_EXECUTABLE = '/bin/echo'
const ENV_LAUNCHER = '/usr/bin/env'
const SYNTHETIC_EXECUTABLE_IDENTITIES = {
    'Claude Code': [DIRECT_EXECUTABLE],
    Codex: [DIRECT_EXECUTABLE],
    OpenCode: [DIRECT_EXECUTABLE],
} as const

function eventsFor(candidatePath = CANDIDATE, brokenPath = BROKEN) {
    const brokenOutput = `${brokenPath}\nCONFIG_INVALID`
    const candidateOutput = `${candidatePath}\nSANDBOX_DENIED`
    return {
    version: {
        cwd: '.',
        command: [DIRECT_EXECUTABLE, '--version'],
        exitCode: 0,
        stream: 'stdout',
        code: 'COMMAND_OK',
        result: 'completed',
        output: '0.0.0-synthetic\nCOMMAND_OK',
        outputSha256: '6bf101c8f0b27d2fdcc43d44842c4914b0c1a8e3b06843419761130c2730bd87',
    },
    help: {
        cwd: '.',
        command: [DIRECT_EXECUTABLE, '--help'],
        exitCode: 0,
        stream: 'stdout',
        code: 'COMMAND_OK',
        result: 'completed',
        output: 'synthetic help\nCOMMAND_OK',
        outputSha256: '51ca227220cd0812ca017816ca9d509ed4cbcd9e3bd72b9d0b0eb23e05faa516',
    },
    brokenControl: {
        cwd: '.',
        command: [DIRECT_EXECUTABLE, '--config', brokenPath, 'synthetic', 'forbidden', 'attempt'],
        exitCode: 2,
        stream: 'stderr',
        code: 'CONFIG_INVALID',
        result: 'rejected',
        output: brokenOutput,
        outputSha256: digest(brokenOutput),
    },
    candidateControl: {
        cwd: '.',
        command: [DIRECT_EXECUTABLE, '--config', candidatePath, 'synthetic', 'forbidden', 'attempt'],
        exitCode: 1,
        stream: 'stderr',
        code: 'SANDBOX_DENIED',
        result: 'refused',
        output: candidateOutput,
        outputSha256: digest(candidateOutput),
    },
    } as const
}

const EVENTS = eventsFor()

function row(overrides: Record<string, unknown> = {}) {
    const candidatePath = typeof overrides.candidatePath === 'string' ? overrides.candidatePath : CANDIDATE
    const brokenPath = typeof overrides.brokenPath === 'string' ? overrides.brokenPath : BROKEN
    const transcriptPath = typeof overrides.transcriptPath === 'string' ? overrides.transcriptPath : TRANSCRIPT
    return {
        harness: 'Codex',
        version: '0.0.0-synthetic',
        date: '2026-08-25',
        capability: 'sandbox',
        candidatePath,
        brokenPath,
        transcriptPath,
        candidateSha256: '5a797caa21dd8e624a735e63a1271a3cb3e23b2ecf32760d8e640bd321e9cc32',
        brokenSha256: '81a727e378977683aa3d133fe4d7ee5e277e92dd5e9f758258a4c3dde328cd83',
        transcriptSha256: 'b94142b98148aec9f684695b57ed7addbdd428fe531a8ed0c9fd2aa926b9bb5b',
        runId: 'synthetic-run-1',
        versionCommand: [DIRECT_EXECUTABLE, '--version'],
        helpCommand: [DIRECT_EXECUTABLE, '--help'],
        invocation: [DIRECT_EXECUTABLE, '--config', '{control}', 'synthetic', 'forbidden', 'attempt'],
        forbiddenAction: 'write a synthetic marker outside the allowed root',
        brokenRejected: true,
        verdict: 'enforced',
        syntheticFixture: CANDIDATE,
        events: eventsFor(candidatePath, brokenPath),
        ...overrides,
    }
}

function digest(body: string | Buffer): string {
    return createHash('sha256').update(body).digest('hex')
}

function writeTranscript(root: string, manifest: ReturnType<typeof row>): void {
    writeFileSync(
        join(root, manifest.transcriptPath),
        `${JSON.stringify(
            {
                harness: manifest.harness,
                version: manifest.version,
                date: manifest.date,
                capability: manifest.capability,
                runId: manifest.runId,
                forbiddenAction: manifest.forbiddenAction,
                verdict: manifest.verdict,
                invocation: manifest.invocation,
                events: manifest.events,
            },
            null,
            2,
        )}\n`,
    )
}

function matrixRows(root: string) {
    return ['Claude Code', 'Codex', 'OpenCode'].flatMap((harness) =>
        ['sandbox', 'approval'].map((capability) => ({ harness, capability })),
    ).map(({ harness, capability }, index) => {
        const directory = join(root, '.cockpit/local/probes', `matrix-${index}`)
        mkdirSync(directory)
        copyFileSync(join(ROOT, CANDIDATE), join(directory, 'candidate-control.json'))
        copyFileSync(join(ROOT, BROKEN), join(directory, 'broken-control.json'))
        const manifest = row({
            harness,
            capability,
            runId: `matrix-run-${index}`,
            candidatePath: `.cockpit/local/probes/matrix-${index}/candidate-control.json`,
            brokenPath: `.cockpit/local/probes/matrix-${index}/broken-control.json`,
            transcriptPath: `.cockpit/local/probes/matrix-${index}/transcript.json`,
        })
        writeTranscript(root, manifest)
        return probeRow(root, manifest)
    })
}

function probeRow(root: string, overrides: Record<string, unknown> = {}) {
    const manifest = row({
        candidatePath: '.cockpit/local/probes/run/candidate-control.json',
        brokenPath: '.cockpit/local/probes/run/broken-control.json',
        transcriptPath: '.cockpit/local/probes/run/synthetic-transcript.txt',
        ...overrides,
    })
    return {
        ...manifest,
        candidateSha256: digest(readFileSync(join(root, manifest.candidatePath))),
        brokenSha256: digest(readFileSync(join(root, manifest.brokenPath))),
        transcriptSha256: digest(readFileSync(join(root, manifest.transcriptPath))),
    }
}

function probeEvidenceRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'harness-evidence-root-'))
    mkdirSync(join(root, '.cockpit/local/probes/run'), { recursive: true })
    mkdirSync(join(root, 'fixtures/harness-probes'), { recursive: true })
    copyFileSync(join(ROOT, CANDIDATE), join(root, '.cockpit/local/probes/run/candidate-control.json'))
    copyFileSync(join(ROOT, BROKEN), join(root, '.cockpit/local/probes/run/broken-control.json'))
    copyFileSync(join(ROOT, TRANSCRIPT), join(root, '.cockpit/local/probes/run/synthetic-transcript.txt'))
    copyFileSync(join(ROOT, CANDIDATE), join(root, CANDIDATE))
    copyFileSync(join(ROOT, BROKEN), join(root, BROKEN))
    copyFileSync(join(ROOT, TRANSCRIPT), join(root, TRANSCRIPT))
    writeTranscript(
        root,
        row({
            candidatePath: '.cockpit/local/probes/run/candidate-control.json',
            brokenPath: '.cockpit/local/probes/run/broken-control.json',
            transcriptPath: '.cockpit/local/probes/run/synthetic-transcript.txt',
        }),
    )
    return root
}

function probeManifestWithCommands(
    root: string,
    versionCommand: string[],
    helpCommand: string[],
    invocation: string[],
    eventCwds: Partial<Record<keyof ReturnType<typeof eventsFor>, string>> = {},
) {
    const candidatePath = '.cockpit/local/probes/run/candidate-control.json'
    const brokenPath = '.cockpit/local/probes/run/broken-control.json'
    const transcriptPath = '.cockpit/local/probes/run/synthetic-transcript.txt'
    const baseEvents = eventsFor(candidatePath, brokenPath)
    const events = {
        ...baseEvents,
        version: { ...baseEvents.version, cwd: eventCwds.version ?? '.', command: versionCommand },
        help: { ...baseEvents.help, cwd: eventCwds.help ?? '.', command: helpCommand },
        brokenControl: {
            ...baseEvents.brokenControl,
            cwd: eventCwds.brokenControl ?? '.',
            command: invocation.map((argument) => (argument === '{control}' ? brokenPath : argument)),
        },
        candidateControl: {
            ...baseEvents.candidateControl,
            cwd: eventCwds.candidateControl ?? '.',
            command: invocation.map((argument) => (argument === '{control}' ? candidatePath : argument)),
        },
    }
    const overrides = { candidatePath, brokenPath, transcriptPath, versionCommand, helpCommand, invocation, events }
    writeTranscript(root, row(overrides))
    return probeRow(root, overrides)
}

describe('paired harness evidence', () => {
    it('requires real probe artifacts before accepting an enforced verdict', () => {
        expect(validateEvidenceManifest(row(), ROOT)).toContain(
            'every verdict requires candidatePath, brokenPath and transcriptPath under .cockpit/local/probes/',
        )

        const root = probeEvidenceRoot()
        try {
            expect(
                validateEvidenceManifest(probeRow(root), root, {
                    testOnlyExecutableIdentities: SYNTHETIC_EXECUTABLE_IDENTITIES,
                }),
            ).toEqual([])
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('returns a refusal when a clean clone has no probe evidence directory', () => {
        const root = probeEvidenceRoot()
        rmSync(join(root, '.cockpit'), { recursive: true, force: true })
        try {
            expect(() => validateEvidenceManifest(row(), root)).not.toThrow()
            expect(validateEvidenceManifest(row(), root)).toContain(
                'every verdict requires candidatePath, brokenPath and transcriptPath under .cockpit/local/probes/',
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects evidence symlinks that resolve outside the repository root', () => {
        const root = probeEvidenceRoot()
        try {
            rmSync(join(root, '.cockpit/local/probes/run/candidate-control.json'))
            symlinkSync('/etc/hosts', join(root, '.cockpit/local/probes/run/candidate-control.json'))
            expect(
                validateEvidenceManifest(
                    row({
                        candidatePath: '.cockpit/local/probes/run/candidate-control.json',
                        brokenPath: '.cockpit/local/probes/run/broken-control.json',
                        transcriptPath: '.cockpit/local/probes/run/synthetic-transcript.txt',
                    }),
                    root,
                ),
            ).toContain('candidatePath resolves outside the repository root')
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects enforced evidence symlinked from the synthetic fixture root', () => {
        const root = probeEvidenceRoot()
        try {
            rmSync(join(root, '.cockpit/local/probes/run/candidate-control.json'))
            symlinkSync(join(root, CANDIDATE), join(root, '.cockpit/local/probes/run/candidate-control.json'))
            expect(
                validateEvidenceManifest(
                    row({
                        candidatePath: '.cockpit/local/probes/run/candidate-control.json',
                        brokenPath: '.cockpit/local/probes/run/broken-control.json',
                        transcriptPath: '.cockpit/local/probes/run/synthetic-transcript.txt',
                    }),
                    root,
                ),
            ).toContain('every verdict requires candidatePath, brokenPath and transcriptPath under .cockpit/local/probes/')
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it.each([
        ['candidatePath', undefined],
        ['brokenPath', undefined],
        ['runId', ''],
        ['versionCommand', ''],
        ['helpCommand', ''],
        ['invocation', ''],
        ['forbiddenAction', ''],
    ])('rejects missing %s evidence', (field, value) => {
        expect(validateEvidenceManifest(row({ [field]: value }), ROOT)).not.toEqual([])
    })

    it('rejects paths that are not colocated or distinct', () => {
        expect(validateEvidenceManifest(row({ brokenPath: CANDIDATE }), ROOT)).not.toEqual([])
        expect(validateEvidenceManifest(row({ brokenPath: 'README.md' }), ROOT)).not.toEqual([])
        expect(dirname(CANDIDATE)).toBe(dirname(BROKEN))
    })

    it('requires evidence to remain colocated after resolving probe symlinks', () => {
        const root = probeEvidenceRoot()
        try {
            for (const directory of ['candidate-real', 'broken-real', 'transcript-real']) {
                mkdirSync(join(root, '.cockpit/local/probes', directory))
            }
            const paths = [
                ['candidate-control.json', 'candidate-real'],
                ['broken-control.json', 'broken-real'],
                ['synthetic-transcript.txt', 'transcript-real'],
            ] as const
            for (const [file, directory] of paths) {
                copyFileSync(join(root, '.cockpit/local/probes/run', file), join(root, '.cockpit/local/probes', directory, file))
                rmSync(join(root, '.cockpit/local/probes/run', file))
                symlinkSync(`../${directory}/${file}`, join(root, '.cockpit/local/probes/run', file))
            }

            expect(validateEvidenceManifest(probeRow(root), root)).toContain(
                'candidatePath, brokenPath and transcriptPath must resolve to one directory',
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects absolute and repository-escaping evidence paths', () => {
        expect(
            validateEvidenceManifest(
                row({ candidatePath: '/etc/passwd', brokenPath: '/etc/hosts', transcriptPath: '/etc/services' }),
                ROOT,
            ),
        ).not.toEqual([])
        expect(
            validateEvidenceManifest(
                row({ candidatePath: '../candidate.json', brokenPath: '../broken.json', transcriptPath: '../run.txt' }),
                ROOT,
            ),
        ).not.toEqual([])
    })

    it('binds the controls and same-run transcript by content digest and structured invocation', () => {
        const root = probeEvidenceRoot()
        try {
            const options = { testOnlyExecutableIdentities: SYNTHETIC_EXECUTABLE_IDENTITIES }
            const valid = probeRow(root)
            expect(validateEvidenceManifest(valid, root, options)).toEqual([])
            expect(validateEvidenceManifest({ ...valid, candidateSha256: '0'.repeat(64) }, root, options)).not.toEqual([])
            expect(validateEvidenceManifest({ ...valid, transcriptSha256: 'f'.repeat(64) }, root, options)).not.toEqual([])
            expect(validateEvidenceManifest({ ...valid, invocation: ['other-tool', '{control}'] }, root, options)).not.toEqual([])
            expect(validateEvidenceManifest({ ...valid, runId: 'a-run-absent-from-the-transcript' }, root, options)).not.toEqual([])
            expect(validateEvidenceManifest({ ...valid, harness: 'Claude Code' }, root, options)).toContain(
                'transcript does not match the structured run evidence',
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('refuses oversized legacy controls and transcripts before reading their contents', () => {
        const root = probeEvidenceRoot()
        try {
            const manifest = probeRow(root)
            for (const field of ['candidatePath', 'brokenPath', 'transcriptPath'] as const) {
                const path = join(root, manifest[field])
                truncateSync(path, 1_048_577)
                expect(validateEvidenceManifest(manifest, root)).toContain(
                    `${field} exceeds the 1048576-byte limit`,
                )
                if (field === 'candidatePath') copyFileSync(join(ROOT, CANDIDATE), path)
                if (field === 'brokenPath') copyFileSync(join(ROOT, BROKEN), path)
            }
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects a broken control run by an unrelated command', () => {
        const root = probeEvidenceRoot()
        try {
            const events = {
                ...EVENTS,
                brokenControl: {
                    ...EVENTS.brokenControl,
                    command: ['node', '-e', 'invalid', 'broken-control.json'],
                },
            }
            const manifest = row({ events })
            writeTranscript(root, manifest)

            expect(validateEvidenceManifest(probeRow(root, { events }), root)).toContain(
                'brokenControl command does not match the shared invocation template',
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects same-named controls when the recorded cwd and command resolve to another pair', () => {
        const root = probeEvidenceRoot()
        try {
            mkdirSync(join(root, '.cockpit/local/probes/other'))
            for (const name of ['candidate-control.json', 'broken-control.json']) {
                copyFileSync(join(root, '.cockpit/local/probes/run', name), join(root, '.cockpit/local/probes/other', name))
            }
            const events = eventsFor(
                '.cockpit/local/probes/other/candidate-control.json',
                '.cockpit/local/probes/other/broken-control.json',
            )
            const manifest = row({
                candidatePath: '.cockpit/local/probes/run/candidate-control.json',
                brokenPath: '.cockpit/local/probes/run/broken-control.json',
                transcriptPath: '.cockpit/local/probes/run/synthetic-transcript.txt',
                events,
            })
            writeTranscript(root, manifest)

            expect(validateEvidenceManifest(probeRow(root, { events }), root)).toEqual(
                expect.arrayContaining([
                    'brokenControl command does not resolve to brokenPath from its cwd',
                    'candidateControl command does not resolve to candidatePath from its cwd',
                ]),
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('binds the declared harness version to the successful version event', () => {
        const root = probeEvidenceRoot()
        try {
            const manifest = row({ version: '9.9.9' })
            writeTranscript(root, manifest)

            expect(validateEvidenceManifest(probeRow(root, { version: '9.9.9' }), root)).toContain(
                'version event output does not contain the declared harness version',
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('requires version evidence from the same harness executable', () => {
        const versionCommand = ['node', '--version']
        const events = { ...EVENTS, version: { ...EVENTS.version, command: versionCommand } }

        expect(validateEvidenceManifest(row({ versionCommand, events }), ROOT)).toContain(
            'versionCommand executable does not match the shared invocation template',
        )
    })

    it('rejects an arbitrary direct binary as Codex evidence', () => {
        const harness = 'Codex'
        const executable = DIRECT_EXECUTABLE
        const versionCommand = [executable, '--version']
        const helpCommand = [executable, '--help']
        const invocation = [executable, '--config', '{control}', 'synthetic', 'forbidden', 'attempt']
        const events = eventsFor()
        const manifest = row({
            harness,
            versionCommand,
            helpCommand,
            invocation,
            events: {
                ...events,
                version: { ...events.version, command: versionCommand },
                help: { ...events.help, command: helpCommand },
                brokenControl: {
                    ...events.brokenControl,
                    command: invocation.map((argument) => (argument === '{control}' ? BROKEN : argument)),
                },
                candidateControl: {
                    ...events.candidateControl,
                    command: invocation.map((argument) => (argument === '{control}' ? CANDIDATE : argument)),
                },
            },
        })

        expect(validateEvidenceManifest(manifest, ROOT)).toContain(
            `${harness} evidence must invoke its harness executable directly`,
        )
    })

    it('rejects one harness executable presented as another harness', () => {
        const root = probeEvidenceRoot()
        try {
            const executable = join(root, '.cockpit/local/probes/run/codex')
            writeFileSync(executable, '#!/bin/sh\n')
            const versionCommand = [executable, '--version']
            const helpCommand = [executable, '--help']
            const invocation = [executable, '--config', '{control}']
            const baseEvents = eventsFor(
                '.cockpit/local/probes/run/candidate-control.json',
                '.cockpit/local/probes/run/broken-control.json',
            )
            const overrides = {
                harness: 'Claude Code',
                versionCommand,
                helpCommand,
                invocation,
                events: {
                    ...baseEvents,
                    version: { ...baseEvents.version, command: versionCommand },
                    help: { ...baseEvents.help, command: helpCommand },
                    brokenControl: {
                        ...baseEvents.brokenControl,
                        command: invocation.map((argument) =>
                            argument === '{control}' ? '.cockpit/local/probes/run/broken-control.json' : argument,
                        ),
                    },
                    candidateControl: {
                        ...baseEvents.candidateControl,
                        command: invocation.map((argument) =>
                            argument === '{control}' ? '.cockpit/local/probes/run/candidate-control.json' : argument,
                        ),
                    },
                },
            }
            writeTranscript(root, row({
                candidatePath: '.cockpit/local/probes/run/candidate-control.json',
                brokenPath: '.cockpit/local/probes/run/broken-control.json',
                transcriptPath: '.cockpit/local/probes/run/synthetic-transcript.txt',
                ...overrides,
            }))

            expect(validateEvidenceManifest(probeRow(root, overrides), root)).toContain(
                'Claude Code evidence must invoke its harness executable directly',
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    // The harness is identified by argv[0] alone, so a launcher there is refused before anything it
    // launches is read: an assignment prefix or a nested shell behind env cannot change the verdict.
    it.each([
        ['another program', [ENV_LAUNCHER, 'another-program', '--version']],
        ['an environment assignment prefix', [ENV_LAUNCHER, 'MODE=synthetic', 'version-tool', '--version']],
        ['a nested shell', [ENV_LAUNCHER, 'sh', '-c', 'version-tool --version']],
    ])('rejects evidence spliced across programs behind env with %s', (_label, versionCommand) => {
        const events = { ...EVENTS, version: { ...EVENTS.version, command: versionCommand } }

        expect(validateEvidenceManifest(row({ versionCommand, events }), ROOT)).toContain(
            'versionCommand must invoke the harness binary directly; env is a generic command launcher',
        )
    })

    it('rejects evidence spliced across programs behind a shell command string', () => {
        const root = probeEvidenceRoot()
        try {
            const versionCommand = ['/bin/sh', '-c', 'version-tool --version']
            const helpCommand = ['/bin/sh', '-c', 'help-tool --help']
            const invocation = ['/bin/sh', '-c', 'probe-tool --config "$1"', 'probe-shell', '{control}']
            // The validator reports the binary /bin/sh resolves to, not the name the manifest
            // declared, and on Debian and Ubuntu that symlink lands on dash rather than sh.
            const shellName = basename(realpathSync('/bin/sh'))

            expect(
                validateEvidenceManifest(
                    probeManifestWithCommands(root, versionCommand, helpCommand, invocation),
                    root,
                ),
            ).toContain(`versionCommand must invoke the harness binary directly; ${shellName} is a generic command launcher`)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it.each(['node', 'npx'])('rejects evidence spliced across programs behind %s', (launcherName) => {
        const root = probeEvidenceRoot()
        try {
            const launcher = join(root, '.cockpit/local/probes/run', launcherName)
            writeFileSync(launcher, '#!/bin/sh\n')
            const versionCommand = [launcher, 'version-tool.js', '--version']
            const helpCommand = [launcher, 'help-tool.js', '--help']
            const invocation = [launcher, 'probe-tool.js', '--config', '{control}']

            expect(
                validateEvidenceManifest(
                    probeManifestWithCommands(root, versionCommand, helpCommand, invocation),
                    root,
                ),
            ).toContain(
                `versionCommand must invoke the harness binary directly; ${launcherName} is a generic command launcher`,
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects a relative program token that resolves differently across event working directories', () => {
        const root = probeEvidenceRoot()
        try {
            for (const directory of ['version-tool', 'help-tool']) {
                mkdirSync(join(root, '.cockpit/local/probes', directory))
                writeFileSync(join(root, '.cockpit/local/probes', directory, 'harness'), '#!/bin/sh\n')
            }
            const versionCommand = ['./harness', '--version']
            const helpCommand = ['./harness', '--help']
            const invocation = ['./harness', '--config', '{control}']
            const manifest = probeManifestWithCommands(root, versionCommand, helpCommand, invocation, {
                version: '.cockpit/local/probes/version-tool',
                help: '.cockpit/local/probes/help-tool',
            })

            expect(validateEvidenceManifest(manifest, root)).toEqual(expect.arrayContaining([
                'versionCommand executable must use an absolute path',
                'version.command executable must use an absolute path',
                'help.command executable must use an absolute path',
            ]))
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it.each([{}, 7, [], ''])('returns named diagnostics for a malformed event command: %j', (command) => {
        const events = { ...EVENTS, version: { ...EVENTS.version, command } }

        expect(() => validateEvidenceManifest(row({ events }), ROOT)).not.toThrow()
        expect(validateEvidenceManifest(row({ events }), ROOT)).toContain(
            'version.command must be a non-empty argv array',
        )
    })

    it('rejects silent controls, unknown verdicts, and unsupported enforcement claims', () => {
        expect(
            validateEvidenceManifest(row({ events: undefined, brokenRejected: false, verdict: 'unavailable' }), ROOT),
        ).not.toEqual([])
        expect(validateEvidenceManifest(row({ verdict: 'supported' }), ROOT)).not.toEqual([])
        expect(
            validateEvidenceManifest(
                row({
                    events: {
                        ...EVENTS,
                        candidateControl: { ...EVENTS.candidateControl, exitCode: 0, result: 'allowed' },
                    },
                }),
                ROOT,
            ),
        ).not.toEqual([])
    })

    it('requires real ignored evidence for unavailable verdicts too', () => {
        expect(validateEvidenceManifest(row({ verdict: 'unavailable', brokenRejected: false }), ROOT)).toContain(
            'every verdict requires candidatePath, brokenPath and transcriptPath under .cockpit/local/probes/',
        )
    })

    it('rejects an unavailable verdict when the same run also allows its broken control', () => {
        const root = probeEvidenceRoot()
        try {
            const baseEvents = eventsFor(
                '.cockpit/local/probes/run/candidate-control.json',
                '.cockpit/local/probes/run/broken-control.json',
            )
            const brokenOutput = '.cockpit/local/probes/run/broken-control.json\nCONTROL_ALLOWED'
            const candidateOutput = '.cockpit/local/probes/run/candidate-control.json\nCONTROL_ALLOWED'
            const events = {
                ...baseEvents,
                brokenControl: {
                    ...baseEvents.brokenControl,
                    exitCode: 0,
                    code: 'CONTROL_ALLOWED',
                    result: 'allowed',
                    output: brokenOutput,
                    outputSha256: digest(brokenOutput),
                },
                candidateControl: {
                    ...baseEvents.candidateControl,
                    exitCode: 0,
                    code: 'CONTROL_ALLOWED',
                    result: 'allowed',
                    output: candidateOutput,
                    outputSha256: digest(candidateOutput),
                },
            }
            const overrides = { verdict: 'unavailable', brokenRejected: false, events }
            writeTranscript(root, row({
                candidatePath: '.cockpit/local/probes/run/candidate-control.json',
                brokenPath: '.cockpit/local/probes/run/broken-control.json',
                transcriptPath: '.cockpit/local/probes/run/synthetic-transcript.txt',
                ...overrides,
            }))

            expect(
                validateEvidenceManifest(probeRow(root, overrides), root, {
                    testOnlyExecutableIdentities: SYNTHETIC_EXECUTABLE_IDENTITIES,
                }),
            ).toContain('every verdict requires a non-zero rejected brokenControl event')
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects unavailable evidence whose structured results contradict their exit status', () => {
        const root = probeEvidenceRoot()
        try {
            const contradictoryEvents = {
                ...EVENTS,
                brokenControl: { ...EVENTS.brokenControl, exitCode: 0 },
                candidateControl: { ...EVENTS.candidateControl, exitCode: 7, result: 'allowed' },
            }
            const overrides = {
                verdict: 'unavailable',
                brokenRejected: true,
                events: contradictoryEvents,
            }
            const manifest = row({
                candidatePath: '.cockpit/local/probes/run/candidate-control.json',
                brokenPath: '.cockpit/local/probes/run/broken-control.json',
                transcriptPath: '.cockpit/local/probes/run/synthetic-transcript.txt',
                ...overrides,
            })
            writeTranscript(root, manifest)

            expect(validateEvidenceManifest(probeRow(root, overrides), root)).toEqual(
                expect.arrayContaining([
                    'brokenControl rejected result requires a non-zero exitCode',
                    'candidateControl allowed result requires exitCode=0',
                    'brokenRejected does not match the brokenControl result and exitCode',
                ]),
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('uses structured refusal events instead of inferring refusal from negated prose', () => {
        const root = probeEvidenceRoot()
        try {
            const negatedEvents = {
                ...EVENTS,
                brokenControl: {
                    ...EVENTS.brokenControl,
                    output: 'control was not invalid',
                    outputSha256: digest('control was not invalid'),
                },
                candidateControl: {
                    ...EVENTS.candidateControl,
                    output: 'action was not denied',
                    outputSha256: digest('action was not denied'),
                },
            }
            const manifest = row({ events: negatedEvents })
            writeTranscript(root, manifest)

            expect(validateEvidenceManifest(probeRow(root, { events: negatedEvents }), root)).toEqual(
                expect.arrayContaining([
                    'brokenControl output does not contain its exact refusal code',
                    'candidateControl output does not contain its exact refusal code',
                ]),
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('proves the broken fixture is rejected while its candidate parses', () => {
        expect(() => JSON.parse(readFileSync(join(ROOT, CANDIDATE), 'utf8'))).not.toThrow()
        expect(() => JSON.parse(readFileSync(join(ROOT, BROKEN), 'utf8'))).toThrow()
    })
})

describe('manifest collection command', () => {
    it('returns a stable object refusal for empty and malformed rows', () => {
        expect(validateEvidenceManifests([], ROOT)).toEqual({ errors: ['no evidence manifests supplied'], rows: [] })
        for (const malformed of [null, 'row', 7, []]) {
            expect(() => validateEvidenceManifests([malformed], ROOT)).not.toThrow()
            expect(validateEvidenceManifests([malformed], ROOT)).toEqual({
                errors: expect.arrayContaining(['row 1: manifest must be an object']),
                rows: [],
            })
        }
        expect(validateEvidenceManifests([{}], ROOT)).toEqual({
            errors: expect.arrayContaining(['row 1: harness must be a non-empty string']),
            rows: [],
        })
    })
    it('rejects one run or evidence triple reused across capability cells', () => {
        const rows = ['Claude Code', 'Codex', 'OpenCode'].flatMap((harness) =>
            ['sandbox', 'approval'].map((capability) => row({ harness, capability })),
        )

        expect(validateEvidenceManifests(rows, ROOT).errors).toEqual(
            expect.arrayContaining([
                'expected six distinct run IDs',
                'expected six distinct evidence triples',
            ]),
        )
    })

    it('rejects distinct lexical evidence triples that resolve to one run', () => {
        const root = probeEvidenceRoot()
        try {
            const rows = ['Claude Code', 'Codex', 'OpenCode'].flatMap((harness) =>
                ['sandbox', 'approval'].map((capability, capabilityIndex) => ({ harness, capability, capabilityIndex })),
            ).map(({ harness, capability }, index) => {
                const directory = join(root, '.cockpit/local/probes', `alias-${index}`)
                mkdirSync(directory)
                for (const name of ['candidate-control.json', 'broken-control.json', 'synthetic-transcript.txt']) {
                    symlinkSync(join(root, '.cockpit/local/probes/run', name), join(directory, name))
                }
                return row({
                    harness,
                    capability,
                    runId: `run-${index}`,
                    candidatePath: `.cockpit/local/probes/alias-${index}/candidate-control.json`,
                    brokenPath: `.cockpit/local/probes/alias-${index}/broken-control.json`,
                    transcriptPath: `.cockpit/local/probes/alias-${index}/synthetic-transcript.txt`,
                })
            })

            expect(validateEvidenceManifests(rows, root).errors).toContain(
                'expected six distinct canonical evidence triples',
            )
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects zero rows and collapsed capability coverage', () => {
        const zero = spawnSync(process.execPath, [VALIDATOR], { cwd: ROOT, encoding: 'utf8' })
        expect(zero.status).not.toBe(0)
        expect(zero.stderr).toContain('no evidence manifests')

        const tmp = mkdtempSync(join(tmpdir(), 'harness-evidence-'))
        try {
            const onlySandbox = ['Claude Code', 'Codex', 'OpenCode'].map((harness, index) => {
                const path = join(tmp, `${index}.json`)
                writeFileSync(path, JSON.stringify(row({ harness })))
                return path
            })
            const collapsed = spawnSync(process.execPath, [VALIDATOR, ...onlySandbox], {
                cwd: ROOT,
                encoding: 'utf8',
            })
            expect(collapsed.status).not.toBe(0)
            expect(collapsed.stderr).toContain('expected exactly six harness/capability rows')
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('refuses an oversized manifest without parsing it', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'harness-evidence-manifest-'))
        try {
            const path = join(tmp, 'oversized.json')
            writeFileSync(path, '')
            truncateSync(path, 1_048_577)
            const result = spawnSync(process.execPath, [VALIDATOR, path], { cwd: ROOT, encoding: 'utf8' })
            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain('manifest exceeds the 1048576-byte limit')
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it.each([
        ['at a position', '{"harness": "CANARY_SECRET_7f3a",\n}', ' at line 2, column 1'],
        ['at an unexpected token', '{\n"harness": CANARY_SECRET_7f3a}', ''],
    ])('names where a malformed manifest stopped parsing without quoting it, %s', (_case, text, where) => {
        const tmp = mkdtempSync(join(tmpdir(), 'harness-evidence-syntax-'))
        try {
            const path = join(tmp, 'broken.json')
            writeFileSync(path, text)
            const result = spawnSync(process.execPath, [VALIDATOR, path], { cwd: ROOT, encoding: 'utf8' })
            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain(`${path}: manifest is not valid JSON${where}; expected one JSON evidence row`)
            expect(result.stderr).not.toContain('CANARY_SECRET_7f3a')
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('returns rows in stable harness then sandbox/approval order', () => {
        const root = probeEvidenceRoot()
        try {
            const rows = matrixRows(root).reverse()
            expect(
                validateEvidenceManifests(rows, root, {
                    testOnlyExecutableIdentities: SYNTHETIC_EXECUTABLE_IDENTITIES,
                }).rows.map((item) => [item.harness, item.capability]),
            ).toEqual([
                ['Claude Code', 'sandbox'],
                ['Claude Code', 'approval'],
                ['Codex', 'sandbox'],
                ['Codex', 'approval'],
                ['OpenCode', 'sandbox'],
                ['OpenCode', 'approval'],
            ])
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })
})

const SELFTEST_NOW = '2026-09-27T00:02:00.000Z'
const SELFTEST_MANIFEST = 'a'.repeat(64)

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[]
    : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T
type TestBuiltinEvidenceRecord = Omit<Mutable<SelftestEvidenceRecord>, 'harness' | 'authority'> & {
    harness: Mutable<BuiltinHarnessRef>
    authority: Mutable<BuiltinExecutionAuthority>
}

function selftestEvent(
    command: string[],
    result: SelftestProbeEvent['result'],
    exitCode: number,
    code: string,
    stream: 'stdout' | 'stderr',
): Mutable<SelftestProbeEvent> {
    const output = `${command.at(-1)}\n${code}`
    return {
        cwd: '.', command, exitCode, signal: null, result, code,
        stdout: stream === 'stdout' ? output : '',
        stderr: stream === 'stderr' ? output : '',
        stdoutSha256: digest(stream === 'stdout' ? output : ''),
        stderrSha256: digest(stream === 'stderr' ? output : ''),
    }
}

function writeSelftestEvidence(
    root: string,
    capability: SelftestCapability,
    verdict: SelftestEvidenceRecord['verdict'],
    index: number,
    skill = 'cockpit-setup',
    harness: BuiltinHarnessRef = { kind: 'builtin', target: 'codexcli', name: 'Codex' },
): TestBuiltinEvidenceRecord {
    const directory = `.cockpit/local/probes/selftest-${index}`
    mkdirSync(join(root, directory), { recursive: true })
    const candidatePath = `${directory}/candidate.json`
    const brokenPath = `${directory}/broken.json`
    const transcriptPath = `${directory}/transcript.json`
    writeFileSync(join(root, candidatePath), `candidate-${index}`)
    writeFileSync(join(root, brokenPath), `broken-${index}`)
    const invocation = [DIRECT_EXECUTABLE, '--config', '{control}']
    const candidateCode = verdict === 'enforced'
        ? 'GUARD_FIRED'
        : verdict === 'instructed' ? 'INSTRUCTION_CANARY' : `${capability.replaceAll('-', '_').toUpperCase()}_UNAVAILABLE`
    const candidateResult = verdict === 'enforced' ? 'refused' : verdict === 'instructed' ? 'accepted' : 'unavailable'
    const candidateExit = verdict === 'instructed' ? 0 : 1
    const record: TestBuiltinEvidenceRecord = {
        kind: 'evidence',
        harness,
        capability,
        generatedManifestSha256: SELFTEST_MANIFEST,
        verdict,
        version: '0.0.0-synthetic',
        measuredOn: '2026-09-27',
        runId: `selftest-run-${index}`,
        startedAt: '2026-09-27T00:00:00.000Z',
        finishedAt: '2026-09-27T00:01:00.000Z',
        expiresAt: '2026-09-27T00:05:00.000Z',
        candidatePath,
        brokenPath,
        transcriptPath,
        candidateSha256: digest(readFileSync(join(root, candidatePath))),
        brokenSha256: digest(readFileSync(join(root, brokenPath))),
        transcriptSha256: '',
        invocation,
        versionCommand: [DIRECT_EXECUTABLE, '--version'],
        helpCommand: [DIRECT_EXECUTABLE, '--help'],
        candidateCode,
        brokenCode: 'BROKEN_CONTROL_REJECTED',
        sample: capability === 'skill-parity' ? { skill, features: ['name', 'trigger'] } : null,
        authority: { kind: 'native-executable', name: harness.name, executable: DIRECT_EXECUTABLE },
        events: {
            version: selftestEvent([DIRECT_EXECUTABLE, '--version'], 'completed', 0, 'VERSION_OK', 'stdout'),
            help: selftestEvent([DIRECT_EXECUTABLE, '--help'], 'completed', 0, 'HELP_OK', 'stdout'),
            brokenControl: selftestEvent(
                [DIRECT_EXECUTABLE, '--config', brokenPath], 'rejected', 2, 'BROKEN_CONTROL_REJECTED', 'stderr',
            ),
            candidateControl: selftestEvent(
                [DIRECT_EXECUTABLE, '--config', candidatePath], candidateResult, candidateExit, candidateCode, 'stdout',
            ),
        },
    }
    record.events.version.stdout = `0.0.0-synthetic\nVERSION_OK`
    record.events.version.stdoutSha256 = digest(record.events.version.stdout)
    if (candidateExit !== 0) {
        record.events.candidateControl = selftestEvent(
            [DIRECT_EXECUTABLE, '--config', candidatePath], candidateResult, candidateExit, candidateCode, 'stderr',
        )
    }
    const { transcriptSha256: _ignored, ...transcript } = record
    writeFileSync(join(root, transcriptPath), JSON.stringify(transcript))
    record.transcriptSha256 = digest(readFileSync(join(root, transcriptPath)))
    return record
}

function selftestFixture() {
    const root = mkdtempSync(join(tmpdir(), 'harness-selftest-root-'))
    mkdirSync(join(root, '.cockpit/local/probes'), { recursive: true })
    const records = [
        writeSelftestEvidence(root, 'instruction-loading', 'instructed', 0),
        writeSelftestEvidence(root, 'guard-firing', 'enforced', 1),
        writeSelftestEvidence(root, 'skill-parity', 'unavailable', 2),
    ]
    const expectation = {
        schema: 'cockpit-harness-selftest-expectation/v1',
        generatedManifestSha256: SELFTEST_MANIFEST,
        cells: records.map(({ harness, capability, sample }) => capability === 'skill-parity'
            ? { harness, capability, skill: sample!.skill }
            : { harness, capability }),
        shippedSkills: ['cockpit-setup'],
        reviewHarnesses: [
            { name: 'Claude Code', nativeDiagnostics: false },
            { name: 'Codex', nativeDiagnostics: true },
        ],
    }
    const skillReviews = expectation.reviewHarnesses.map(({ name }) => ({
        skill: 'cockpit-setup', harness: name, status: 'human_needed', reviewedOn: null, evidenceRunId: null,
        reviewers: [], checks: null, operatorAction: `Review bootstrap with ${name}`,
    }))
    const bundle = {
        schema: 'cockpit-harness-selftest/v1', generatedManifestSha256: SELFTEST_MANIFEST,
        records, skillInventory: ['cockpit-setup'], skillReviews,
    }
    const options = { testOnlyNow: SELFTEST_NOW, testOnlyExecutableIdentities: SYNTHETIC_EXECUTABLE_IDENTITIES }
    return { root, expectation, bundle, options }
}

function operatorExecutableFixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'operator-identity-')))
    mkdirSync(join(root, 'bin'), { recursive: true })
    const executable = join(root, 'bin', 'synthetic-harness')
    copyFileSync(DIRECT_EXECUTABLE, executable)
    const record = writeSelftestEvidence(root, 'guard-firing', 'enforced', 0)
    record.invocation = [executable, '--config', '{control}']
    record.authority.executable = executable
    record.versionCommand[0] = executable
    record.helpCommand[0] = executable
    for (const event of Object.values(record.events)) event.command[0] = executable
    for (const [name, path] of [['brokenControl', record.brokenPath], ['candidateControl', record.candidatePath]] as const) {
        record.events[name].command = record.invocation.map((word) => word === '{control}' ? path : word)
    }
    const { transcriptSha256: _unused, ...transcript } = record
    writeFileSync(join(root, record.transcriptPath), JSON.stringify(transcript))
    record.transcriptSha256 = digest(readFileSync(join(root, record.transcriptPath)))
    return { root, executable, record }
}

describe('operator executable identity', () => {
    it('refuses an oversized sparse executable before allocating or reading its bytes', () => {
        const fixture = operatorExecutableFixture()
        const selftest = selftestFixture()
        vi.useFakeTimers()
        vi.setSystemTime(new Date(SELFTEST_NOW))
        try {
            const options = { testOnlyNow: SELFTEST_NOW, operatorExecutableIdentities: new Map([
                ['Codex' as const, { canonicalPath: fixture.executable, sha256: digest(readFileSync(fixture.executable)) }],
            ]) }
            const record = fixture.record
            const checkOperator = () => validateSelftestEvidenceBundle({ ...selftest.bundle, records: [record] }, {
                ...selftest.expectation, cells: [{ harness: record.harness, capability: record.capability }],
            }, fixture.root, options)
            expect(checkOperator().errors).toEqual([])
            truncateSync(fixture.executable, 536_870_913)

            // Memory-boundary guards keep the regression safe even against the vulnerable reader.
            const allocations: number[] = []
            const guard = (size: number) => {
                if (size >= 65_536) { allocations.push(size); throw new Error('Oversized executable reached buffer allocation') }
            }
            const allocate = Buffer.alloc
            const allocateUnsafe = Buffer.allocUnsafe
            const allocateSlow = Buffer.allocUnsafeSlow
            const spies = [
                vi.spyOn(Buffer, 'alloc').mockImplementation((size, fill, encoding) => { guard(size); return allocate(size, fill, encoding) }),
                vi.spyOn(Buffer, 'allocUnsafe').mockImplementation((size) => { guard(size); return allocateUnsafe(size) }),
                vi.spyOn(Buffer, 'allocUnsafeSlow').mockImplementation((size) => { guard(size); return allocateSlow(size) }),
            ]
            try {
                const result = checkOperator()
                expect(result.evidence).toEqual([])
                expect(result.errors).toContain('record 1: harness executable exceeds the 536870912-byte limit')
                expect(allocations).toEqual([])
            } finally { for (const spy of spies) spy.mockRestore() }
        } finally {
            vi.useRealTimers()
            rmSync(fixture.root, { recursive: true, force: true })
            rmSync(selftest.root, { recursive: true, force: true })
        }
    })
})

describe('versioned harness selftest evidence', () => {
    it('keeps the legacy mechanism closed and exposes one versioned validator', () => {
        expect(IMPLEMENTED_MECHANISMS).toEqual([{
            id: 'harness-evidence-validation',
            exports: ['validateEvidenceManifest', 'validateEvidenceManifests', 'validateSelftestEvidenceBundle'],
        }])
        expect(validateEvidenceManifests([], ROOT)).toEqual({ errors: ['no evidence manifests supplied'], rows: [] })
    })

    it('accepts complete driven evidence without promoting operator remainders', () => {
        const fixture = selftestFixture()
        try {
            const result = validateSelftestEvidenceBundle(
                fixture.bundle, fixture.expectation, fixture.root, fixture.options,
            )
            expect(result.errors).toEqual([])
            expect(result.evidence).toHaveLength(3)
            expect(result.pending).toEqual([])
            expect(result.skillReviews).toHaveLength(2)
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it('does not treat a PATH-shadowed harness name as executable identity authority', () => {
        const fixture = selftestFixture()
        const bin = join(fixture.root, 'shadow-bin')
        const shadow = join(bin, 'codex')
        const originalPath = process.env.PATH
        try {
            mkdirSync(bin)
            symlinkSync(DIRECT_EXECUTABLE, shadow)
            for (const record of fixture.bundle.records) {
                record.invocation[0] = shadow
                record.versionCommand[0] = shadow
                record.helpCommand[0] = shadow
                record.events.version.command[0] = shadow
                record.events.help.command[0] = shadow
                record.events.brokenControl.command[0] = shadow
                record.events.candidateControl.command[0] = shadow
                const { transcriptSha256: _ignored, ...transcript } = record
                writeFileSync(join(fixture.root, record.transcriptPath), JSON.stringify(transcript))
                record.transcriptSha256 = digest(readFileSync(join(fixture.root, record.transcriptPath)))
            }
            process.env.PATH = bin
            expect(validateSelftestEvidenceBundle(
                fixture.bundle, fixture.expectation, fixture.root, { testOnlyNow: SELFTEST_NOW },
            ).errors).toEqual(expect.arrayContaining([
                'record 1: Codex evidence must invoke its harness executable directly',
            ]))
        } finally {
            if (originalPath === undefined) delete process.env.PATH
            else process.env.PATH = originalPath
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it('accepts one skill-parity evidence cell per shipped skill and review harness', () => {
        const root = mkdtempSync(join(tmpdir(), 'harness-selftest-matrix-'))
        const skills = ['alpha', 'beta', 'zeta']
        const reviewHarnesses = [
            { name: 'Claude Code', nativeDiagnostics: false },
            { name: 'Codex', nativeDiagnostics: true },
        ] as const
        const harnesses = [
            { kind: 'builtin', target: 'claudecode', name: 'Claude Code' },
            { kind: 'builtin', target: 'codexcli', name: 'Codex' },
        ] as const
        try {
            const records = [
                writeSelftestEvidence(root, 'instruction-loading', 'instructed', 0),
                writeSelftestEvidence(root, 'guard-firing', 'enforced', 1),
                ...harnesses.flatMap((harness, harnessIndex) => skills.map((skill, skillIndex) =>
                    writeSelftestEvidence(root, 'skill-parity', 'unavailable', 2 + harnessIndex * skills.length + skillIndex, skill, harness),
                )),
            ]
            const expectation = {
                schema: 'cockpit-harness-selftest-expectation/v1',
                generatedManifestSha256: SELFTEST_MANIFEST,
                cells: records.map(({ harness, capability, sample }) => capability === 'skill-parity'
                    ? { harness, capability, skill: sample!.skill }
                    : { harness, capability }),
                shippedSkills: skills,
                reviewHarnesses,
            }
            const skillReviews = records.filter(record => record.capability === 'skill-parity').map(record => ({
                skill: record.sample!.skill,
                harness: record.harness.name,
                status: 'evidenced',
                reviewedOn: '2026-09-27',
                evidenceRunId: record.runId,
                reviewers: record.harness.name === 'Codex'
                    ? ['official-authoring', 'harness-diagnostics']
                    : ['official-authoring'],
                checks: { trigger: 'pass', silence: 'pass', bodyLoad: 'pass', tools: 'pass', nonGoals: 'pass' },
                operatorAction: null,
            }))
            const bundle = {
                schema: 'cockpit-harness-selftest/v1',
                generatedManifestSha256: SELFTEST_MANIFEST,
                records,
                skillInventory: skills,
                skillReviews,
            }
            const result = validateSelftestEvidenceBundle(bundle, expectation, root, {
                testOnlyNow: SELFTEST_NOW,
                testOnlyExecutableIdentities: SYNTHETIC_EXECUTABLE_IDENTITIES,
            })
            expect(result.errors).toEqual([])
            expect(result.evidence).toHaveLength(8)
            expect(result.skillReviews).toHaveLength(6)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects missing, duplicate, and unexpected cells against external expectation authority', () => {
        const fixture = selftestFixture()
        try {
            const missing = structuredClone(fixture.bundle)
            missing.records.pop()
            expect(validateSelftestEvidenceBundle(missing, fixture.expectation, fixture.root, fixture.options).errors)
                .toContain('bundle records do not exactly cover expected cells')
            const duplicate = structuredClone(fixture.bundle)
            duplicate.records.push(structuredClone(duplicate.records[0]))
            expect(validateSelftestEvidenceBundle(duplicate, fixture.expectation, fixture.root, fixture.options).errors)
                .toContain('bundle records contain duplicate cells')
            const extra = {
                ...structuredClone(fixture.bundle),
                records: [
                    ...structuredClone(fixture.bundle.records),
                    { ...structuredClone(fixture.bundle.records[0]), capability: 'unknown-capability' },
                ],
            }
            expect(validateSelftestEvidenceBundle(extra, fixture.expectation, fixture.root, fixture.options).errors)
                .toEqual(expect.arrayContaining(['record 4: unknown selftest capability: unknown-capability']))
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it('rejects stale, copied, fabricated, and mismatched evidence', () => {
        const fixture = selftestFixture()
        try {
            const stale = structuredClone(fixture.bundle)
            stale.records[0].expiresAt = '2026-09-27T00:01:30.000Z'
            expect(validateSelftestEvidenceBundle(stale, fixture.expectation, fixture.root, fixture.options).errors)
                .toEqual(expect.arrayContaining(['record 1: evidence has expired']))

            const copied = structuredClone(fixture.bundle)
            copied.records[1].runId = copied.records[0].runId
            copied.records[1].candidatePath = copied.records[0].candidatePath
            copied.records[1].brokenPath = copied.records[0].brokenPath
            copied.records[1].transcriptPath = copied.records[0].transcriptPath
            expect(validateSelftestEvidenceBundle(copied, fixture.expectation, fixture.root, fixture.options).errors)
                .toEqual(expect.arrayContaining(['evidence run IDs must be unique', 'evidence triples must be unique']))

            const fabricated = structuredClone(fixture.bundle)
            fabricated.records[1].events.candidateControl.exitCode = 0
            expect(validateSelftestEvidenceBundle(fabricated, fixture.expectation, fixture.root, fixture.options).errors)
                .toEqual(expect.arrayContaining(['record 2: candidateControl refused result requires a non-zero exitCode']))

            const mismatch = structuredClone(fixture.bundle)
            mismatch.generatedManifestSha256 = 'b'.repeat(64)
            expect(validateSelftestEvidenceBundle(mismatch, fixture.expectation, fixture.root, fixture.options).errors)
                .toContain('bundle generatedManifestSha256 does not match expectation')
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it('keeps human-needed records separate and refuses unavailable as a dependency fallback', () => {
        const fixture = selftestFixture()
        try {
            const pending = structuredClone(fixture.bundle) as unknown as {
                records: Array<Record<string, unknown>>
            } & Omit<typeof fixture.bundle, 'records'>
            pending.records[0] = {
                kind: 'human_needed', harness: pending.records[0].harness, capability: 'instruction-loading',
                generatedManifestSha256: SELFTEST_MANIFEST, observedAt: '2026-09-27T00:00:00.000Z',
                reason: 'authentication_required', operatorAction: 'Authenticate Codex and rerun the instruction probe',
            }
            const result = validateSelftestEvidenceBundle(pending, fixture.expectation, fixture.root, fixture.options)
            expect(result.errors).toEqual([])
            expect(result.pending).toHaveLength(1)
            expect(result.evidence).toHaveLength(2)

            const pendingSkill = structuredClone(fixture.bundle) as unknown as {
                records: Array<Record<string, unknown>>
            } & Omit<typeof fixture.bundle, 'records'>
            pendingSkill.records[2] = {
                kind: 'human_needed', harness: pendingSkill.records[2].harness, capability: 'skill-parity',
                skill: 'cockpit-setup', generatedManifestSha256: SELFTEST_MANIFEST,
                observedAt: '2026-09-27T00:00:00.000Z', reason: 'isolation_unavailable',
                operatorAction: 'Provide an isolated skill review workspace',
            }
            expect(validateSelftestEvidenceBundle(
                pendingSkill, fixture.expectation, fixture.root, fixture.options,
            ).errors).toEqual([])
            delete pendingSkill.records[2].skill
            expect(validateSelftestEvidenceBundle(
                pendingSkill, fixture.expectation, fixture.root, fixture.options,
            ).errors).toEqual(expect.arrayContaining([
                'record 3: record 3.skill must be a bounded skill name',
                'record 3: cell is not present in expectation authority',
                'record 3: human-needed record contains unknown or missing fields',
            ]))

            const disguised = structuredClone(fixture.bundle)
            disguised.records[0].verdict = 'unavailable'
            disguised.records[0].events.candidateControl.result = 'unavailable'
            disguised.records[0].events.candidateControl.exitCode = 1
            expect(validateSelftestEvidenceBundle(disguised, fixture.expectation, fixture.root, fixture.options).errors)
                .not.toEqual([])
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it('requires the complete two-harness skill review matrix and accepted custom identity', () => {
        const fixture = selftestFixture()
        try {
            const incomplete = structuredClone(fixture.bundle)
            incomplete.skillReviews.pop()
            expect(validateSelftestEvidenceBundle(incomplete, fixture.expectation, fixture.root, fixture.options).errors)
                .toContain('skillReviews do not exactly cover the shipped skill and review harness matrix')

            const custom: CustomHarnessRef = {
                kind: 'custom', id: 'review-shell', declarationSha256: 'c'.repeat(64),
                module: 'adapters/review-shell.mjs', sourceSha256: 'd'.repeat(64), export: 'generate',
            }
            const customExpectation = {
                ...structuredClone(fixture.expectation),
                cells: fixture.expectation.cells.map((cell, index) => index === 0
                    ? { ...structuredClone(cell), harness: structuredClone(custom) }
                    : structuredClone(cell)),
            }
            const customRecord: Mutable<SelftestEvidenceRecord> = {
                ...structuredClone(fixture.bundle.records[0]),
                harness: structuredClone(custom),
                authority: {
                    kind: 'custom-module', harnessId: custom.id, module: custom.module,
                    sourceSha256: custom.sourceSha256, export: custom.export, stepId: 'probe-step-1',
                    startedAt: fixture.bundle.records[0].startedAt, finishedAt: fixture.bundle.records[0].finishedAt,
                },
            }
            const customBundle = {
                ...structuredClone(fixture.bundle),
                records: [customRecord, ...structuredClone(fixture.bundle.records.slice(1))],
            }
            const { transcriptSha256: _ignored, ...customTranscript } = customRecord
            writeFileSync(join(fixture.root, customRecord.transcriptPath), JSON.stringify(customTranscript))
            customRecord.transcriptSha256 = digest(
                readFileSync(join(fixture.root, customRecord.transcriptPath)),
            )
            expect(validateSelftestEvidenceBundle(
                customBundle, customExpectation, fixture.root, fixture.options,
            ).errors).toEqual([])
            const moduleRefused = (module: string) => validateSelftestEvidenceBundle(customBundle, {
                ...customExpectation,
                cells: customExpectation.cells.map((cell, index) => index === 0 ? { ...cell, harness: { ...custom, module } } : cell),
            }, fixture.root, fixture.options).errors.some(error => error.endsWith('.module must be a confined relative path'))
            expect(moduleRefused('.GIT/hooks/review-shell.mjs')).toBe(true)
            expect(moduleRefused('adapters/Node_Modules/review-shell.mjs')).toBe(true)
            expect(moduleRefused('internal/review-shell.mjs')).toBe(false)
            customRecord.harness = { ...custom, sourceSha256: 'e'.repeat(64) }
            const authority = customRecord.authority
            if (authority.kind !== 'custom-module') throw new Error('custom authority fixture was not installed')
            authority.sourceSha256 = 'e'.repeat(64)
            expect(validateSelftestEvidenceBundle(
                customBundle, customExpectation, fixture.root, fixture.options,
            ).errors).toEqual(expect.arrayContaining([
                'record 1: harness identity does not equal expected cell',
                'record 1: custom authority does not match expected harness identity',
            ]))
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it('rejects accessors, proxies, excess rows, and oversized evidence before hostile traversal', () => {
        const fixture = selftestFixture()
        try {
            const malformedAuthority = {
                ...structuredClone(fixture.expectation),
                reviewHarnesses: [null, null],
            }
            expect(() => validateSelftestEvidenceBundle(
                fixture.bundle, malformedAuthority, fixture.root, fixture.options,
            )).not.toThrow()
            expect(validateSelftestEvidenceBundle(
                fixture.bundle, malformedAuthority, fixture.root, fixture.options,
            )).toEqual({
                errors: ['expectation reviewHarnesses must be exactly Claude Code then Codex'],
                evidence: [],
                pending: [],
                skillReviews: [],
            })

            let getterCalls = 0
            const accessorBundle = { ...fixture.bundle }
            Object.defineProperty(accessorBundle, 'records', {
                enumerable: true,
                get() {
                    getterCalls += 1
                    return fixture.bundle.records
                },
            })
            expect(validateSelftestEvidenceBundle(
                accessorBundle, fixture.expectation, fixture.root, fixture.options,
            ).errors).toContain('bundle must contain only bounded own data')
            expect(getterCalls).toBe(0)

            let proxyGets = 0
            const proxyBundle = new Proxy(fixture.bundle, {
                get(target, property, receiver) {
                    proxyGets += 1
                    return Reflect.get(target, property, receiver)
                },
            })
            expect(validateSelftestEvidenceBundle(
                proxyBundle, fixture.expectation, fixture.root, fixture.options,
            ).errors).toContain('bundle must contain only bounded own data')
            expect(proxyGets).toBe(0)

            let rowGetterCalls = 0
            const hostileRows = Array.from({ length: 257 }, () => {
                const row = {}
                Object.defineProperty(row, 'kind', {
                    enumerable: true,
                    get() {
                        rowGetterCalls += 1
                        return 'evidence'
                    },
                })
                return row
            })
            expect(validateSelftestEvidenceBundle(
                { ...fixture.bundle, records: hostileRows }, fixture.expectation, fixture.root, fixture.options,
            ).errors).toContain('bundle must contain only bounded own data')
            expect(rowGetterCalls).toBe(0)

            const excessExpectation = {
                ...fixture.expectation,
                cells: Array.from({ length: 257 }, () => fixture.expectation.cells[0]),
            }
            expect(validateSelftestEvidenceBundle(
                fixture.bundle, excessExpectation, fixture.root, fixture.options,
            ).errors).toContain('expectation must contain only bounded own data')

            const oversizedBundle = {
                ...fixture.bundle,
                generatedManifestSha256: 'x'.repeat(4_194_305),
            }
            expect(validateSelftestEvidenceBundle(
                oversizedBundle, fixture.expectation, fixture.root, fixture.options,
            ).errors).toContain('bundle must contain only bounded own data')

            writeFileSync(join(fixture.root, fixture.bundle.records[0].candidatePath), Buffer.alloc(65_537))
            expect(validateSelftestEvidenceBundle(
                fixture.bundle, fixture.expectation, fixture.root, fixture.options,
            ).errors).toContain('record 1: candidatePath exceeds the 65536-byte limit')
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })
})
