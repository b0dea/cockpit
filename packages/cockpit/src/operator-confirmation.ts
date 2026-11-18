import { createInterface } from 'node:readline'

/**
 * One step a person approves or declines: what it does, why it waits for them, and what it covers.
 * `details` say what runs or changes and are always shown whole; `notes` explain, and are cut to one
 * line until the person asks for them in full.
 */
export type Approval = Readonly<{ title: string; why: string; details: readonly string[]; notes?: readonly string[] }>

/** The streams a person answers on. */
export type PersonIo = Readonly<{ stdin?: NodeJS.ReadStream; stderr: Pick<NodeJS.WriteStream, 'write'> & { readonly isTTY?: boolean } }>

// Agent tools mark the commands they run: Claude Code sets CLAUDECODE, Codex CODEX_THREAD_ID and
// OpenCode OPENCODE. A pseudo-terminal an agent opens passes for a person's, so approval also
// refuses inside a session marked by one of these.
const AGENT_SESSION_VARIABLES = ['CLAUDECODE', 'CODEX_THREAD_ID', 'OPENCODE'] as const

/** The variable that marks `env` as an agent tool's session, or undefined outside one. */
function agentSessionVariable(env: Readonly<Record<string, string | undefined>>): string | undefined {
    return AGENT_SESSION_VARIABLES.find(name => env[name] !== undefined && env[name] !== '')
}

/**
 * Why this run has no person to ask, or undefined when it has one. Both streams of `io` must be a
 * terminal: the screen goes to stderr, and a yes typed while it is redirected away approves something
 * nobody saw. Without `io`, only the environment is checked.
 */
export function personAbsence(io: PersonIo | undefined, env: Readonly<Record<string, string | undefined>>, json: boolean): string | undefined {
    if (json) return '--json is for programs, not a person'
    if (env.CI) return 'CI is set'
    const variable = agentSessionVariable(env)
    if (variable) return `this terminal belongs to an agent session (${variable} is set)`
    if (io && (io.stdin?.isTTY !== true || io.stderr.isTTY !== true)) return 'standard input and error are not both a terminal'
    return undefined
}

// Agent-written text is shown to a person with its control and bidirectional-override characters
// replaced, so it can neither drive their terminal nor read in an order other than the one recorded.
export const shown = (value: string) => value.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '�')

// A stored word may hold a newline or a tab; on screen each line stays one line.
const line = (text: string) => shown(text.replaceAll('\n', '\\n').replaceAll('\t', '\\t'))
const WIDTH = 90
const brief = (text: string) => text.length > WIDTH ? `${text.slice(0, WIDTH - 1)}…` : text

/** One answer typed at the terminal, or undefined when input ends or the person presses Ctrl-C. */
async function question(io: PersonIo, text: string): Promise<string | undefined> {
    if (!io.stdin) return undefined
    const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
    try {
        return await new Promise(resolve => {
            prompt.once('close', () => resolve(undefined))
            prompt.once('SIGINT', () => prompt.close())
            prompt.question(text, answer => resolve(answer))
        })
    } finally {
        prompt.close()
    }
}

/**
 * Shows one step on a short screen and returns whether the person approved it, or undefined when they
 * stopped (Ctrl-C or the end of input). `d` prints the notes in full and asks again; only y or yes approves.
 */
export async function askApproval(io: PersonIo, approval: Approval, progress: string): Promise<boolean | undefined> {
    const notes = approval.notes ?? []
    io.stderr.write(`\n${progress}  ${line(approval.title)}\nWhy you: ${line(approval.why)}\n`
        + [...approval.details.map(line), ...notes.map(note => brief(line(note)))].map(text => `  ${text}\n`).join(''))
    for (;;) {
        const answer = (await question(io, 'Approve? [y/N, d = details] '))?.trim().toLowerCase()
        if (answer === undefined) return undefined
        if (answer !== 'd') return answer === 'y' || answer === 'yes'
        io.stderr.write(notes.map(note => `  ${line(note)}\n`).join(''))
    }
}

/** A note the step records, typed by the person: empty when they give none, undefined when they stopped. */
export async function askNote(io: PersonIo): Promise<string | undefined> {
    return (await question(io, 'Note: '))?.trim()
}
