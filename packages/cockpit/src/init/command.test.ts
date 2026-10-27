import { describe, expect, it } from 'vitest'
import { runInitOperatorCommand, type InitCommandIo } from './command.js'
import type { InitApplicationOutcome } from '../environment/init-application.js'

const pending = (): InitApplicationOutcome => ({
    kind: 'pending', status: 0, artifact: null, destination: null, diagnostics: [],
    result: { stage: 'surface-previewed', root: '/synthetic', target: 'codexcli', previewSha256: 'a'.repeat(64),
        files: [{ path: '.agents/skills/bootstrap/SKILL.md', sha256: 'b'.repeat(64) }], nextCommand: 'confirm selected bootstrap preview' },
})

describe('init operator command', () => {
    it('returns preview unchanged when noninteractive or JSON and never confirms or writes', async () => {
        const calls: string[] = []
        const io: InitCommandIo = {
            terminal: false,
            confirm: async () => { calls.push('confirm'); return undefined },
            writeArtifact: async () => { calls.push('write') },
        }

        const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
            { interactive: false, json: true }, io, async () => { calls.push('application'); return pending() })

        expect(outcome).toEqual(pending())
        expect(calls).toEqual(['application'])
    })

    it('returns the exact pending preview for interactive JSON before terminal or confirmation', async () => {
        const calls: string[] = []

        const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
            { interactive: true, json: true }, {
                terminal: false,
                confirm: async () => { calls.push('confirm'); return undefined },
                writeArtifact: async () => { calls.push('write') },
            }, async () => { calls.push('application'); return pending() })

        expect(outcome).toEqual(pending())
        expect(calls).toEqual(['application'])
    })

    it('accepts only the exact preview digest and writes only a persisted application artifact', async () => {
        const calls: string[] = []
        const artifact: InitApplicationOutcome = {
            kind: 'artifact', status: 0, diagnostics: [], artifact: 'name = "synthetic"\n', destination: '/synthetic/cockpit.toml',
            result: { stage: 'draft-prepared', root: '/synthetic', target: 'codexcli', previewSha256: 'a'.repeat(64),
                files: [{ path: '.agents/skills/bootstrap/SKILL.md', sha256: 'b'.repeat(64) }], nextCommand: 'write the exact cockpit.toml artifact' },
        }
        const complete: InitApplicationOutcome = {
            kind: 'complete', status: 0, diagnostics: [], artifact: null, destination: null,
            result: { stage: 'environment-verified', root: '/synthetic', target: 'codexcli', previewSha256: 'a'.repeat(64),
                files: [{ path: '.agents/skills/bootstrap/SKILL.md', sha256: 'b'.repeat(64) }], nextCommand: 'bootstrap complete' },
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
        const answers = { sibling: [{ slug: 'app' }], ports: { bases: {} }, environment: { install_policies: [], compose_files: ['compose.yml'] } }
        const walk = (given: string[]) => {
            const sent: string[] = []
            const questions = [asking('sibling'), asking('ports.bases'), asking('environment.install_policies'),
                asking('environment.generated'), asking('configuration.defaults', defaultsDigest)]
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
                '[{"slug":"app"}]', '{}', '[]', '{"compose_files":["compose.yml"]}', JSON.stringify({ confirmed: true, sha256: defaultsDigest }),
            ])
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

        it('names an answers key that matches no interview field and an ambiguous environment answer', async () => {
            const unknown = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers: { sibling: [], ports: { base: {} } } } },
                noTerminal, async () => pending())
            expect(unknown).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_FIELD_UNKNOWN',
                message: expect.stringContaining('names no interview field: ports.base;') }] })

            const ambiguous = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
                { interactive: false, json: true, unattended: { previewSha256: digest, answers: {
                    sibling: [], ports: { bases: {} }, environment: { install_policies: [], generated: {}, compose_files: ['compose.yml'] } } } },
                noTerminal, walk([]).application)
            expect(ambiguous).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_AMBIGUOUS' }] })
        })
    })
})
