export const MODEL_INPUT_PROTOCOLS: readonly string[]
export function nativeClaudeImport(bytes: string): boolean
export function nativeClaudeContent(bytes: string): string
export function nativeInputSettings(cwd: string): string
export function nativeInputInvocation(target: 'claudecode' | 'codexcli', skill?: string): [string, ...string[]]
export function nativeSkillBody(bytes: string): string | undefined
export function validateNativeModelInputPair(input: {
    target: 'claudecode' | 'codexcli'; skill?: string; candidateInput: string; brokenInput: string;
    candidatePath: string; brokenPath: string; candidateBytes: string; brokenBytes: string;
    brokenStdout: string; brokenStderr: string;
}): string | null
