export interface NativeGuardObservation { endpoint: string; input: string; receipts: readonly string[] }
export function nativeGuardCommands(host: string, port: string, nonce: string): {
    forbiddenCommand: string; allowedCommand: string; receiptMarker: string; ordinaryMarker: string;
}
export function nativeGuardInvocation(host: string): [string, ...string[]]
export function brokenNativeGuardSettings(bytes: string, command: string): string | undefined
export function validateNativeGuardPair(input: {
    host: string; brokenCommand: string; candidateBytes: string; brokenBytes: string;
    observations: { candidate: NativeGuardObservation; broken: NativeGuardObservation };
    candidateStdout: string; brokenStdout: string;
}): string | null
