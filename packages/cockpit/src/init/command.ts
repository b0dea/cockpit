import { randomUUID } from 'node:crypto'
import type { SurfaceTarget } from '../surfaces/contract.js'
import { runInitApplication, type InitApplicationInput, type InitApplicationOutcome } from '../environment/init-application.js'

export const mechanism = {
    id: 'init-command',
    module: 'packages/cockpit/src/init/command.ts',
    exports: ['runInitOperatorCommand'],
} as const

export interface InitCommandInput {
    readonly root: string
    readonly target: SurfaceTarget
    readonly registry?: string
    readonly sessionId?: string
    readonly platform?: 'darwin' | 'linux'
    readonly home?: string
    readonly xdgStateHome?: string
}

export interface InitCommandOptions {
    readonly interactive: boolean
    readonly json: boolean
}

export interface InitCommandIo {
    readonly terminal: boolean
    readonly confirm: (preview: NonNullable<InitApplicationOutcome['result']>) => Promise<string | undefined>
    readonly writeArtifact: (destination: string, artifact: string) => Promise<void>
    readonly answerQuestion?: (question: NonNullable<NonNullable<InitApplicationOutcome['result']>['question']>) => Promise<string | undefined>
}

export type InitApplicationHandler = (input: InitApplicationInput) => Promise<InitApplicationOutcome>

// Real interviews ask up to seven questions; the bound only stops an application that never converges from looping forever.
const MAX_INTERVIEW_ANSWERS = 64

function refusal(code: string, message: string): InitApplicationOutcome {
    return { kind: 'refusal', status: 2, artifact: null, destination: null,
        diagnostics: [{ severity: 'error', code, message }], result: null }
}

export async function runInitOperatorCommand(
    input: InitCommandInput,
    options: InitCommandOptions,
    io: InitCommandIo,
    application: InitApplicationHandler,
): Promise<InitApplicationOutcome> {
    const shared = {
        root: input.root,
        target: input.target,
        ...(input.registry === undefined ? {} : { registry: input.registry }),
        sessionId: input.sessionId ?? randomUUID(),
        platform: input.platform ?? (process.platform === 'darwin' ? 'darwin' : 'linux'),
        home: input.home ?? process.env.HOME,
        ...(input.xdgStateHome === undefined ? {} : { xdgStateHome: input.xdgStateHome }),
    } as const
    const preview = await application({ ...shared, accepted: false })
    if (preview.kind !== 'pending' || preview.status !== 0 || !options.interactive) return preview
    if (options.json) return preview
    if (!io.terminal) return refusal('INIT_TERMINAL_REQUIRED', 'interactive init requires an attached terminal')
    const accepted = { ...shared, accepted: true, acceptedPreviewSha256: preview.result!.previewSha256 } as const
    let outcome: InitApplicationOutcome
    if (preview.result?.question === undefined) {
        const answer = await io.confirm(preview.result!)
        if (answer !== preview.result!.previewSha256) {
            return refusal('INIT_PREVIEW_NOT_ACCEPTED', 'type the exact preview digest to accept the selected bootstrap target')
        }
        outcome = await application(accepted)
    } else outcome = preview
    for (let answered = 0; outcome.kind === 'pending' && outcome.result?.question !== undefined; answered += 1) {
        if (answered >= MAX_INTERVIEW_ANSWERS) return refusal('INIT_INTERVIEW_LIMIT_EXCEEDED',
            `the interview still asks questions after ${MAX_INTERVIEW_ANSWERS} answers; rerun cockpit init to resume from the persisted answers`)
        if (!io.answerQuestion) return outcome
        const bytes = await io.answerQuestion(outcome.result.question)
        if (bytes === undefined) return refusal('GREENFIELD_ANSWER_REQUIRED', 'greenfield init requires an explicit answer to the named question')
        outcome = await application({ ...accepted, greenfieldAnswer: {
            questionId: outcome.result.question.id, bytes, provenance: 'operator-confirmed',
        } })
    }
    if (outcome.kind !== 'artifact' || outcome.artifact === null || outcome.destination === null) return outcome
    try {
        await io.writeArtifact(outcome.destination, outcome.artifact)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            return refusal('INIT_ARTIFACT_WRITE_FAILED', `cockpit.toml could not be written (${(error as NodeJS.ErrnoException).code ?? 'unknown I/O error'})`)
        }
    }
    outcome = await application(accepted)
    return outcome
}
