/**
 * Classifies local Docker transports without rewriting endpoint identity. Context observation and
 * execution authentication remain with the runtime owners; syntax alone grants neither.
 */
export function parseLocalDockerEndpoint(value: unknown): Readonly<{ transport: 'unix'; endpoint: string }> | undefined {
    // Docker trims host input. Reject that alias rather than bind authority to a different string.
    if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return undefined
    if (!value.startsWith('unix://')) return undefined
    const path = value.slice('unix://'.length)
    // Docker passes this raw pathname to the socket transport: spaces and URI punctuation are literal.
    return path.startsWith('/') && !path.startsWith('//') && path.length > 1
        ? { transport: 'unix', endpoint: value } : undefined
}

/** Admits transport syntax for this process without granting native execution or state authority. */
export function admitLocalDockerEndpoint(value: unknown): ReturnType<typeof parseLocalDockerEndpoint> {
    return process.platform === 'darwin' || process.platform === 'linux' ? parseLocalDockerEndpoint(value) : undefined
}
