export interface NpmPackArtifact {
    readonly filename: string
    readonly files: readonly { readonly path: string }[]
}

function invalid(reason: string): never {
    throw new Error(`npm pack --json returned invalid output: ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseNpmPackJson(output: string): NpmPackArtifact {
    let decoded: unknown
    try {
        decoded = JSON.parse(output)
    } catch (error) {
        if (error instanceof SyntaxError) invalid('response is not JSON')
        throw error
    }

    let candidate: unknown
    if (Array.isArray(decoded)) {
        if (decoded.length !== 1) invalid(`expected one package, received ${decoded.length}`)
        candidate = decoded[0]
    } else if (isRecord(decoded)) {
        const entries = Object.entries(decoded)
        if (entries.length !== 1) invalid(`expected one package, received ${entries.length}`)
        candidate = entries[0]?.[1]
    } else {
        invalid('expected a one-package array or package-keyed object')
    }

    if (!isRecord(candidate)) invalid('package entry is not an object')
    if (typeof candidate.filename !== 'string' || candidate.filename.length === 0) {
        invalid('package entry has no filename')
    }
    if (!Array.isArray(candidate.files)) invalid('package entry has no files inventory')
    if (!candidate.files.every((file) => isRecord(file) && typeof file.path === 'string' && file.path.length > 0)) {
        invalid('files inventory contains an entry without a path')
    }

    return {
        filename: candidate.filename,
        files: candidate.files.map((file) => ({ path: file.path as string })),
    }
}
