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
