import { createInterface } from 'node:readline'

/** A person's yes returns the displayed identity, never a digest supplied by terminal input. */
export async function confirmDigest(
    io: { stdin?: NodeJS.ReadStream; stderr: Pick<NodeJS.WriteStream, 'write'> },
    digest: string,
    question: string,
): Promise<string | undefined> {
    if (io.stdin?.isTTY !== true) return undefined
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
