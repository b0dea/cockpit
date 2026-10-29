/**
 * Classifies local Docker transports without rewriting endpoint identity. Context observation and
 * execution authentication remain with the runtime owners; syntax alone grants neither.
 */
export function parseLocalDockerEndpoint(value: unknown): Readonly<{ transport: 'unix' | 'npipe'; endpoint: string }> | undefined {
    // Docker trims host input. Reject that alias rather than bind authority to a different string.
    if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return undefined
    if (value.startsWith('unix://')) {
        const path = value.slice('unix://'.length)
        // Docker passes this raw pathname to the socket transport: spaces and URI punctuation are literal.
        return path.startsWith('/') && !path.startsWith('//') && path.length > 1
            ? Object.freeze({ transport: 'unix', endpoint: value }) : undefined
    }
    // Only the dot server names this computer. One closed pipe-name component excludes remote
    // servers, path traversal, encoded aliases and separator reinterpretation without URL parsing.
    const pipe = /^npipe:\/\/\/\/\.\/pipe\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.exec(value)
    return pipe !== null && `\\\\.\\pipe\\${pipe[1]!}`.length <= 256
        ? Object.freeze({ transport: 'npipe', endpoint: value }) : undefined
}

/** Admits transport syntax for this process without granting native execution or state authority. */
export function admitLocalDockerEndpoint(value: unknown): ReturnType<typeof parseLocalDockerEndpoint> {
    const endpoint = parseLocalDockerEndpoint(value)
    const transport = process.platform === 'win32' ? 'npipe'
        : process.platform === 'darwin' || process.platform === 'linux' ? 'unix' : undefined
    return endpoint?.transport === transport ? endpoint : undefined
}
