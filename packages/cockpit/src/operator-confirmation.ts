import { createInterface } from 'node:readline'

/**
 * A person's yes returns the displayed identity, never a digest supplied by terminal input. Both
 * streams must be a terminal: the preview is written to stderr, and a yes typed while it is
 * redirected away approves something nobody saw.
 */
export async function confirmDigest(
    io: { stdin?: NodeJS.ReadStream; stderr: Pick<NodeJS.WriteStream, 'write'> & { readonly isTTY?: boolean } },
    digest: string,
    question: string,
): Promise<string | undefined> {
    if (io.stdin?.isTTY !== true || io.stderr.isTTY !== true) return undefined
    const prompt = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: true })
    try {
        return await new Promise(resolve => {
            prompt.once('close', () => resolve(undefined))
            prompt.question(`${question} [yes/no]: `, answer => resolve(answer.trim().toLowerCase() === 'yes' ? digest : undefined))
        })
    } finally {
        prompt.close()
    }
}

// Agent tools mark the commands they run: Claude Code sets CLAUDECODE, Codex CODEX_THREAD_ID and
// OpenCode OPENCODE. A pseudo-terminal an agent opens satisfies the terminal check above, so a
// confirmation that approves what agents may do also refuses inside a session marked by one of these.
const AGENT_SESSION_VARIABLES = ['CLAUDECODE', 'CODEX_THREAD_ID', 'OPENCODE'] as const

/** The variable that marks `env` as an agent tool's session, or undefined outside one. */
export function agentSessionVariable(env: Readonly<Record<string, string | undefined>>): string | undefined {
    return AGENT_SESSION_VARIABLES.find(name => env[name] !== undefined && env[name] !== '')
}
