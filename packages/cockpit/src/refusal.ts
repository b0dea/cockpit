/** A command refusal with one error diagnostic: exit status 2, no result and nothing to write. */
export function refusalOutcome(code: string, message: string, target?: string, fix?: string) {
    return {
        kind: 'refusal' as const, status: 2 as const, artifact: null, destination: null, result: null,
        diagnostics: [{ severity: 'error' as const, code, message, ...(target === undefined ? {} : { target }), ...(fix === undefined ? {} : { fix }) }],
    }
}
