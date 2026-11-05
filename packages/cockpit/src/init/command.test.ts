import { describe, expect, it } from 'vitest'
import { runInitOperatorCommand, type InitCommandIo } from './command.js'
import type { InitApplicationInput, InitApplicationOutcome } from '../environment/init-application.js'

const pending = (): InitApplicationOutcome => ({
    kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: [],
    result: { stage: 'surface-previewed', root: '/synthetic', target: 'codexcli', previewSha256: 'a'.repeat(64),
        files: [{ path: '.agents/skills/cockpit-setup/SKILL.md', sha256: 'b'.repeat(64) }] },
})

describe('init operator command', () => {
    it('refuses an unsupported host platform before application while retaining an explicit supported platform', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
        let applicationCalls = 0
        try {
            Object.defineProperty(process, 'platform', { ...platform, value: 'freebsd' })

            const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true }, {
                    terminal: false,
                    confirm: async () => undefined,
                    writeArtifact: async () => undefined,
                }, async () => { applicationCalls += 1; return pending() })

            expect(outcome).toMatchObject({ kind: 'refusal', status: 2, diagnostics: [{
                code: 'STATE_ROOT_UNAVAILABLE',
                message: 'init cannot select a state root on freebsd — bootstrap state ownership is implemented only for macOS and Linux; fix: run npx --no cockpit init <cockpit root> --target <target> on a supported macOS or Linux host',
            }] })
            expect(applicationCalls).toBe(0)

            const explicit = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli', platform: 'linux' },
                { interactive: false, json: true }, {
                    terminal: false,
                    confirm: async () => undefined,
                    writeArtifact: async () => undefined,
                }, async input => { applicationCalls += 1; expect(input.platform).toBe('linux'); return pending() })
            expect(explicit).toEqual(pending())
            expect(applicationCalls).toBe(1)
        } finally {
            Object.defineProperty(process, 'platform', platform)
        }
    })

    // Interactive JSON returns the preview before the terminal check, so no terminal is not a refusal.
    it.each([false, true])('returns the pending preview unchanged for JSON (interactive: %s) and never confirms or writes', async interactive => {
        const calls: string[] = []
        const io: InitCommandIo = {
            terminal: false,
            confirm: async () => { calls.push('confirm'); return undefined },
            writeArtifact: async () => { calls.push('write') },
        }

        const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
            { interactive, json: true }, io, async () => { calls.push('application'); return pending() })

        expect(outcome).toEqual(pending())
        expect(calls).toEqual(['application'])
    })

    it('accepts only the exact preview digest and writes only a persisted application artifact', async () => {
        const calls: string[] = []
        const artifact: InitApplicationOutcome = {
            kind: 'artifact', status: 0, diagnostics: [], artifact: 'name = "synthetic"\n', destination: '/synthetic/cockpit.toml',
            result: { stage: 'draft-prepared', root: '/synthetic', target: 'codexcli', previewSha256: 'a'.repeat(64),
                files: [{ path: '.agents/skills/cockpit-setup/SKILL.md', sha256: 'b'.repeat(64) }] },
        }
        const complete: InitApplicationOutcome = {
            kind: 'complete', status: 0, diagnostics: [], artifact: null, destination: null,
            result: { stage: 'environment-verified', root: '/synthetic', target: 'codexcli', previewSha256: 'a'.repeat(64),
                files: [{ path: '.agents/skills/cockpit-setup/SKILL.md', sha256: 'b'.repeat(64) }] },
        }
        let invocation = 0
        const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
            { interactive: true, json: false }, {
                terminal: true,
                confirm: async () => { calls.push('confirm'); return 'a'.repeat(64) },
                writeArtifact: async (destination, bytes) => { calls.push(`write:${destination}:${bytes}`) },
            }, async (input) => {
                calls.push(`application:${input.accepted}:${input.acceptedPreviewSha256 ?? 'none'}`)
                invocation += 1
                return invocation === 1 ? pending() : invocation === 2 ? artifact : complete
            })

        expect(outcome).toEqual(complete)
        expect(calls).toEqual([
            'application:false:none', 'confirm', `application:true:${'a'.repeat(64)}`,
            'write:/synthetic/cockpit.toml:name = "synthetic"\n', `application:true:${'a'.repeat(64)}`,
        ])
    })

    it('presents one durable greenfield question and returns its operator-confirmed answer to the application', async () => {
        const question = { ...pending(), result: { ...pending().result!, question: {
            id: `question:${'c'.repeat(64)}`, field: 'api.runnable', source: 'api/package.json', why: 'unknown command',
        } } }
        const calls: string[] = []
        const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
            { interactive: true, json: false }, {
                terminal: true,
                confirm: async () => 'a'.repeat(64),
                answerQuestion: async value => { calls.push(`question:${value.id}`); return 'npm run dev' },
                writeArtifact: async () => undefined,
            }, async input => {
                calls.push(`application:${input.accepted}:${input.greenfieldAnswer?.bytes ?? 'none'}`)
                if (calls.length === 1) return pending()
                if (!input.greenfieldAnswer) return question
                return { ...question, kind: 'pending-dependency', status: 2,
                    diagnostics: [{ severity: 'error', code: 'GREENFIELD_RENDER_PENDING', message: 'pending' }] }
            })
        expect(outcome).toMatchObject({ kind: 'pending-dependency', diagnostics: [{ code: 'GREENFIELD_RENDER_PENDING' }] })
        expect(calls).toEqual(['application:false:none', 'application:true:none', `question:question:${'c'.repeat(64)}`, 'application:true:npm run dev'])
    })

    it('resumes a durable question without confirming the accepted preview again', async () => {
        const question = { ...pending(), result: { ...pending().result!, question: {
            id: `question:${'d'.repeat(64)}`, field: 'api.runnable', source: 'api/package.json', why: 'unknown command',
        } } }
        const calls: string[] = []
        await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' }, { interactive: true, json: false }, {
            terminal: true,
            confirm: async () => { calls.push('confirm'); return 'a'.repeat(64) },
            answerQuestion: async () => { calls.push('answer'); return 'npm run dev' },
            writeArtifact: async () => undefined,
        }, async input => {
            calls.push(`application:${input.accepted}`)
            return input.greenfieldAnswer ? { ...question, kind: 'pending-dependency', status: 2 } : question
        })
        expect(calls).toEqual(['application:false', 'answer', 'application:true'])
    })

    it('returns a direct reset result or non-routing refusal without probing another root', async () => {
        const reset = { field: 'environment.compose_files' }
        const direct = { ...pending(), result: { ...pending().result!, resetAnswer: {
            ...reset, revision: 1, invalidatedFields: [reset.field], previewSha256: 'e'.repeat(64),
        } } }
        const refusal: InitApplicationOutcome = { kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
            diagnostics: [{ severity: 'error', code: 'STATE_RECORD_MALFORMED', message: 'state is malformed' }] }
        const io: InitCommandIo = { terminal: false, confirm: async () => undefined, writeArtifact: async () => undefined }
        for (const outcome of [direct, refusal]) {
            let calls = 0
            const returned = await runInitOperatorCommand({ root: '/work/app', target: 'codexcli', resetAnswer: reset },
                { interactive: false, json: true }, io, async () => { calls += 1; return outcome })
            expect(returned).toBe(outcome)
            expect(calls).toBe(1)
        }
    })

    it('routes an answer reset from the original product root to its accepted dedicated cockpit', async () => {
        const product = '/work/app', dedicated = '/work/app-cockpit', resetDigest = 'e'.repeat(64)
        const rootQuestion = { field: 'cockpit.root' as const, why: 'product repository', recommended: 'dedicated' as const, options: [
            { answer: 'dedicated' as const, root: dedicated, creates: [dedicated], siblingsRoot: '..', firstSibling: product, tradeOff: 'clean' },
            { answer: 'in-repo' as const, root: product, creates: [], siblingsRoot: '.', firstSibling: product, tradeOff: 'carries files' },
        ] }
        const calls: string[] = []
        const application = async (input: InitApplicationInput): Promise<InitApplicationOutcome> => {
            calls.push(`${input.root}:${input.cockpitRoot?.kind ?? 'none'}:${input.resetAnswer?.acceptedPreviewSha256 ?? (input.resetAnswer ? 'preview' : 'discover')}`)
            if (input.resetAnswer === undefined) return { ...pending(), result: { ...pending().result!, cockpitRoot: rootQuestion } }
            if (input.root === product) return { kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
                diagnostics: [{ severity: 'error', code: 'INIT_ANSWER_RESET_UNAVAILABLE', message: 'no recorded answers' }] }
            if (input.resetAnswer.acceptedPreviewSha256 !== undefined
                && input.resetAnswer.acceptedPreviewSha256 !== resetDigest) {
                return { kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
                    diagnostics: [{ severity: 'error', code: 'INIT_ANSWER_RESET_STALE', message: 'reset preview changed' }] }
            }
            return { ...pending(), result: { ...pending().result!, root: dedicated, resetAnswer: {
                field: input.resetAnswer.field, revision: 7, invalidatedFields: [input.resetAnswer.field], previewSha256: resetDigest,
            } } }
        }
        const io: InitCommandIo = { terminal: false, confirm: async () => undefined, writeArtifact: async () => undefined }

        const preview = await runInitOperatorCommand({ root: product, target: 'codexcli', resetAnswer: {
            field: 'environment.compose_files',
        } }, { interactive: false, json: true }, io, application)

        expect(preview).toMatchObject({ kind: 'pending', result: { root: dedicated, resetAnswer: {
            field: 'environment.compose_files', previewSha256: resetDigest,
        } } })
        expect(calls).toEqual([
            `${product}:none:preview`, `${product}:none:discover`, `${dedicated}:dedicated:preview`,
        ])

        calls.length = 0
        const accepted = await runInitOperatorCommand({ root: product, target: 'codexcli', resetAnswer: {
            field: 'environment.compose_files', acceptedPreviewSha256: resetDigest,
        } }, { interactive: false, json: true }, io, application)
        expect(accepted).toMatchObject({ kind: 'pending', result: { root: dedicated } })
        expect(calls).toEqual([
            `${product}:none:preview`, `${product}:none:discover`,
            `${dedicated}:dedicated:preview`, `${dedicated}:dedicated:${resetDigest}`,
        ])

        const stale = await runInitOperatorCommand({ root: product, target: 'codexcli', resetAnswer: {
            field: 'environment.compose_files', acceptedPreviewSha256: 'f'.repeat(64),
        } }, { interactive: false, json: true }, io, application)
        expect(stale).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_RESET_STALE' }] })
    })

    it('keeps answering until the interview is done instead of stopping after three answers', async () => {
        const total = 7
        let answerCount = 0
        const question = (index: number): InitApplicationOutcome => ({ ...pending(), result: { ...pending().result!, question: {
            id: `question:${String(index).padStart(64, '0')}`, field: `repository-${index}.runnable`,
            source: `repository-${index}/package.json`, why: 'unknown command',
        } } })
        const artifact: InitApplicationOutcome = { kind: 'artifact', status: 0, diagnostics: [], artifact: 'name = "synthetic"\n',
            destination: '/synthetic/cockpit.toml', result: pending().result! }
        const written: string[] = []
        const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
            { interactive: true, json: false }, {
                terminal: true,
                confirm: async () => 'a'.repeat(64),
                answerQuestion: async () => `npm run service-${answerCount++}`,
                writeArtifact: async destination => { written.push(destination) },
            }, async input => {
                if (!input.accepted) return pending()
                if (written.length > 0) return { ...artifact, kind: 'complete', artifact: null, destination: null }
                return answerCount < total ? question(answerCount) : artifact
            })

        expect(answerCount).toBe(total)
        expect(written).toEqual(['/synthetic/cockpit.toml'])
        expect(outcome).toMatchObject({ kind: 'complete', status: 0 })
    })
    describe('without a terminal', () => {
        const digest = 'a'.repeat(64), defaultsDigest = 'd'.repeat(64)
        const asking = (field: string, expectedSha256?: string): InitApplicationOutcome => ({ ...pending(), result: { ...pending().result!,
            question: { id: `question:${field.length.toString().padStart(64, '0')}`, field, source: 'configuration:x', why: 'unknown',
                ...(expectedSha256 ? { expectedSha256 } : {}) } } })
        const noTerminal: InitCommandIo = { terminal: false, confirm: async () => { throw new Error('asked a terminal') },
            writeArtifact: async () => undefined }
        const machine = { runtime_memory_mb: 2048, runtime_cpus: 2, free_disk_mb: 10240, cold_start_seconds: 120 }
        const guards = { hosted_db_hosts: ['db.staging.example.invalid'], vendor_endpoint_hosts: [] }
        const posture = { addressing: 'port', authentication: 'none', posture_requirements: [{ requirement: 'leased-localhost-ports', addressing: 'port' }] }
        const answers = { sibling: [{ slug: 'app' }], ports: { bases: {} },
            environment: { install_policies: [], test_data: { seeded_data: false, signed_in_users: false },
                compose_files: ['compose.yml'], machine, posture }, guards, work: { grading: 'off' } }
        const walk = (given: string[]) => {
            const sent: string[] = []
            const questions = [asking('sibling'), asking('ports.bases'), asking('environment.install_policies'),
                asking('environment.test_data'), asking('environment.compose_files'), asking('environment.machine'),
                asking('environment.posture'), asking('guards'), asking('work.grading'),
                asking('configuration.defaults', defaultsDigest)]
            const application = async (input: { accepted: boolean; greenfieldAnswer?: { bytes: string } }) => {
                if (!input.accepted) return pending()
                if (input.greenfieldAnswer) sent.push(input.greenfieldAnswer.bytes)
                const next = questions.shift()
                return next ?? { kind: 'complete' as const, status: 0 as const, diagnostics: [], artifact: null, destination: null, result: pending().result }
            }
            return { sent, application, given }
        }

        it('completes with the printed digests and answers keyed by field, never opening a terminal', async () => {
            const { sent, application } = walk([])
            const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers, defaultsSha256: defaultsDigest } },
                noTerminal, application)
            expect(outcome.kind).toBe('complete')
            expect(sent).toEqual([
                '[{"slug":"app"}]', '{}', '[]', '{"seeded_data":false,"signed_in_users":false}',
                '["compose.yml"]', JSON.stringify(machine), JSON.stringify(posture), JSON.stringify(guards), '"off"',
                JSON.stringify({ confirmed: true, sha256: defaultsDigest }),
            ])
        })

        it('reports runtime answers made irrelevant when an empty Compose answer changes the interview', async () => {
            const offered = asking('environment.compose_files')
            const fields = ['environment.compose_files', 'environment.machine', 'environment.posture']
            const preview: InitApplicationOutcome = { ...offered, result: { ...offered.result!, interview: {
                answered: [], inferenceSkipped: [], outstanding: fields.map(field => ({ field, why: 'runtime declaration',
                    confirmedBy: 'person' as const, proposals: [] })),
            } } }
            const sent: string[] = []
            const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest,
                    answers: { environment: { compose_files: [], machine, posture } } } }, noTerminal, async input => {
                    if (!input.greenfieldAnswer) return preview
                    sent.push(input.greenfieldAnswer.bytes)
                    return { ...pending(), kind: 'complete', status: 0, result: { ...pending().result!,
                        interview: { answered: ['environment.compose_files'], outstanding: [], inferenceSkipped: [] } } }
                })
            expect(sent).toEqual(['[]'])
            expect(outcome).toMatchObject({ kind: 'complete', diagnostics: [{ severity: 'warning', code: 'INIT_ANSWER_UNUSED',
                message: 'the answers file gave environment.machine, environment.posture, which the interview never asked for' }] })
        })

        it('records who chose each answer: the human, the setup agent as a default, or for the machine floor no one said', async () => {
            const provenances = async (answersFile: Record<string, unknown>) => {
                const recorded: string[] = []
                const { application } = walk([])
                const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                    { interactive: false, json: true, unattended: { previewSha256: digest, answers: answersFile, defaultsSha256: defaultsDigest } },
                    noTerminal, async input => {
                        if (input.greenfieldAnswer) recorded.push(input.greenfieldAnswer.provenance)
                        return application(input)
                    })
                return { outcome, recorded }
            }
            const marked = await provenances({ ...answers, provenance: { 'environment.compose_files': 'agent-default',
                environment: { machine: 'human' }, guards: 'agent-default' } })
            expect(marked.outcome.kind).toBe('complete')
            expect(marked.recorded).toEqual(['operator-confirmed', 'operator-confirmed', 'operator-confirmed', 'operator-confirmed',
                'agent-default', 'operator-confirmed', 'operator-confirmed', 'agent-default', 'operator-confirmed', 'operator-confirmed'])
            // cockpit proposes at most part of a machine floor, so an unmarked one is not attributed to the human.
            expect((await provenances(answers)).recorded[5]).toBe('unattributed')

            for (const [provenance, message] of [
                [{ guards: 'person' }, 'provenance.guards must be "human", "agent-default" or "derived"'],
                [{ cockpit: { root: 'agent-default' } }, 'provenance names no recorded interview answer: cockpit.root'],
                [{ 'cockpit.name': 'agent-default' }, 'provenance names cockpit.name, which the answers file does not answer'],
            ] as const) {
                const refused = await provenances({ ...answers, provenance })
                expect(refused.outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_INVALID', message: expect.stringContaining(message) }] })
                expect(refused.recorded).toEqual([])
            }
        })

        it('refuses a digest that is not the pending one before publishing anything', async () => {
            const accepted: boolean[] = []
            const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: 'b'.repeat(64), answers } }, noTerminal,
                async input => { accepted.push(input.accepted); return pending() })
            expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_PREVIEW_NOT_ACCEPTED' }] })
            expect(accepted).toEqual([false])
        })

        it('stops at the first unanswered field and withholds the defaults until their digest is given', async () => {
            const { sent, application } = walk([])
            const partial = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers: { sibling: [] } } }, noTerminal, application)
            expect(partial).toMatchObject({ kind: 'pending', result: { question: { field: 'ports.bases' } } })
            expect(sent).toEqual(['[]'])

            const held = walk([])
            const awaiting = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers } }, noTerminal, held.application)
            expect(awaiting).toMatchObject({ kind: 'pending', result: { question: { field: 'configuration.defaults', expectedSha256: defaultsDigest } } })

            const wrong = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers, defaultsSha256: 'e'.repeat(64) } },
                noTerminal, walk([]).application)
            expect(wrong).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_DEFAULTS_NOT_ACCEPTED' }] })
        })

        it('refuses a value that differs from an answer an earlier run recorded, before publishing', async () => {
            const resumed = (): InitApplicationOutcome => ({ ...asking('ports.bases'), result: { ...asking('ports.bases').result!,
                estate: { answers: [{ questionId: 'question:x', bytes: '{"B":2,"A":1}', sha256: 'x', provenance: 'operator-confirmed' }] } as never,
                interview: { answered: ['ports.bases'], outstanding: [], inferenceSkipped: [] } } })
            const calls: boolean[] = []
            const run = (bases: unknown) => runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers: { ports: { bases } } } }, noTerminal,
                async input => { calls.push(input.accepted); return input.accepted ? asking('configuration.defaults', defaultsDigest) : resumed() })
            const conflict = await run({ A: 1, B: 3 })
            expect(conflict).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_CONFLICT', message: expect.stringContaining('ports.bases') }] })
            expect(calls).toEqual([false])
            calls.length = 0
            expect(await run({ A: 1, B: 2 })).toMatchObject({ kind: 'pending' })
            expect(calls).toContain(true)
        })

        it.each(['dedicated', 'in-repo'] as const)('creates only the previewed folder for a %s cockpit root and runs init there', async (answer) => {
            const rootQuestion = { field: 'cockpit.root' as const, why: 'product repository', recommended: 'dedicated' as const, options: [
                { answer: 'dedicated' as const, root: '/work/app-cockpit', creates: ['/work/app-cockpit'], siblingsRoot: '..', firstSibling: '/work/app', tradeOff: 'clean' },
                { answer: 'in-repo' as const, root: '/work/app', creates: [], siblingsRoot: '.', firstSibling: '/work/app', tradeOff: 'carries files' }] }
            const calls: string[] = []
            const outcome = await runInitOperatorCommand({ root: '/work/app', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers: { cockpit: { root: answer } } } },
                { ...noTerminal, createCockpitRoot: async path => { calls.push(`create:${path}`) } },
                async input => {
                    calls.push(`application:${input.accepted}:${input.root}:${JSON.stringify(input.cockpitRoot ?? null)}`)
                    if (input.cockpitRoot === undefined) return { ...pending(), result: { ...pending().result!, cockpitRoot: rootQuestion } }
                    return input.accepted ? asking('sibling') : pending()
                })
            expect(outcome).toMatchObject({ kind: 'pending', result: { question: { field: 'sibling' } } })
            expect(outcome.diagnostics).toEqual([])
            expect(calls).toEqual(answer === 'dedicated' ? [
                'application:false:/work/app:null', 'create:/work/app-cockpit',
                'application:false:/work/app-cockpit:{"kind":"dedicated","firstSibling":"/work/app"}',
                'application:true:/work/app-cockpit:{"kind":"dedicated","firstSibling":"/work/app"}',
            ] : [
                'application:false:/work/app:null', 'application:false:/work/app:{"kind":"in-repo"}', 'application:true:/work/app:{"kind":"in-repo"}',
            ])
        })

        it('refuses an unavailable cockpit root option before creating anything', async () => {
            const created: string[] = []
            const outcome = await runInitOperatorCommand({ root: '/work/My_App', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers: { cockpit: { root: 'dedicated' } } } },
                { ...noTerminal, createCockpitRoot: async path => { created.push(path) } },
                async () => ({ ...pending(), result: { ...pending().result!, cockpitRoot: { field: 'cockpit.root', why: 'product repository',
                    recommended: 'dedicated', options: [{ answer: 'dedicated', root: '/work/My_App-cockpit', creates: ['/work/My_App-cockpit'],
                        siblingsRoot: '..', firstSibling: '/work/My_App', tradeOff: 'clean', unavailable: 'not a valid sibling slug' }] } } }))
            expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_COCKPIT_ROOT_UNAVAILABLE' }] })
            expect(created).toEqual([])
        })

        it('names an answers key that matches no interview field, including an environment table cockpit no longer has', async () => {
            const unknown = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers: { sibling: [], ports: { base: {} } } } },
                noTerminal, async () => pending())
            expect(unknown).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_FIELD_UNKNOWN',
                message: expect.stringContaining('names no interview field: ports.base;') }] })

            const removed = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers: {
                    sibling: [], ports: { bases: {} }, environment: { install_policies: [],
                        test_data: { seeded_data: false, signed_in_users: false }, generated: {}, compose_files: ['compose.yml'] } } } },
                noTerminal, walk([]).application)
            expect(removed).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_FIELD_UNKNOWN',
                message: expect.stringContaining('names no interview field: environment.generated') }] })
        })
    })
})
