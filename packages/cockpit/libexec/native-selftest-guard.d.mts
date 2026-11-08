export interface NativeGuardObservation { endpoint: string; input: string; receipts: readonly string[] }
export function nativeGuardCommands(host: string, port: string, nonce: string): {
    forbiddenCommand: string; allowedCommand: string; receiptMarker: string; ordinaryMarker: string;
}
export function nativeGuardInvocation(host: string): [string, ...string[]]
export function brokenNativeGuardSettings(bytes: string, guardCommand: string | undefined, brokenCommand: string):
    Readonly<{ bytes: string; problem?: undefined }> | Readonly<{ problem: string; bytes?: undefined }>
export function validNativeGuardHookCommand(value: unknown): value is string
export function nativeGuardInterference(stdout: string): readonly string[]
export function validateNativeGuardPair(input: {
    host: string; guardCommand: string | undefined; brokenCommand: string; candidateBytes: string; brokenBytes: string;
    observations: { candidate: NativeGuardObservation; broken: NativeGuardObservation };
    candidateStdout: string; brokenStdout: string;
}): string | null
