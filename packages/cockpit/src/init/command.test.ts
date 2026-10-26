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

    it('answers at most three questions per round and returns the fourth pending without refusal', async () => {
        let answerCount = 0
        const question = (index: number): InitApplicationOutcome => ({ ...pending(), result: { ...pending().result!, question: {
            id: `question:${String(index).padStart(64, '0')}`, field: `repository-${index}.runnable`,
            source: `repository-${index}/package.json`, why: 'unknown command',
        } } })
        const outcome = await runInitOperatorCommand({ root: '/synthetic', target: 'codexcli' },
            { interactive: true, json: false }, {
                terminal: true,
                confirm: async () => 'a'.repeat(64),
                answerQuestion: async () => `npm run service-${answerCount++}`,
                writeArtifact: async () => undefined,
            }, async input => input.greenfieldAnswer === undefined
                ? (input.accepted ? question(0) : pending())
                : question(answerCount))

        expect(answerCount).toBe(3)
        expect(outcome).toMatchObject({ kind: 'pending', status: 0, result: { question: { field: 'repository-3.runnable' } } })
        expect(outcome.diagnostics).toEqual([])
    })
})
